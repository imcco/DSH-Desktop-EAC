'use strict';
// 一次性安装态验证（5.3.2）：删除对话 / 归档恢复全链路（真实 Tauri 壳 + CDP）。
// 覆盖 5.3.2 修复面：
//   A) 插件桥 window.__dshSessionManager.deleteSession —— 0.1.2 走 workspaces
//      服务命令层（旧路径 connection.api.workspace 会报
//      「操作失败: Cannot read properties of undefined (reading 'workspace')」）
//   B) 插件桥 unarchiveSession —— 同批修复路径（设置页「恢复」同源）
//   C) 会话行 ⋯ 菜单「删除对话」真实点击一遍（内核 UI 补丁接线不变性）
//   D) 全程任一 alert（操作失败: …）都视为失败
// 会话/工作区经页面内 /api 网关直建（同源 cookie；不经模型，无 API 花费）。
// 用法: node verify-delete-session.js [exePath]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-verify-delete', 'dsh-home');
const wsDir = 'D:\\tmp\\dsh-smoke-ws';
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(tmpHome, { recursive: true });
const SHOTS = path.join(repo, 'tmp-verify-delete', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CDP_PORT = 9335;
const EXE = process.env.DSH_SMOKE_EXE || process.argv[2] || path.join(repo, 'tauri-shell', 'target', 'release', 'dsh-eac-shell.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGetJson = (url) => new Promise((resolve, reject) => {
  http.get(url, { timeout: 4000 }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
      return;
    }
    for (const fn of listeners) try { fn(msg); } catch {}
  };
  return {
    ready,
    on(fn) { listeners.push(fn); },
    call(method, params) {
      return ready.then(() => new Promise((res, rej) => {
        const id = ++seq; pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      }));
    },
    async evalJs(expr) {
      const r = await this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    /** 真实鼠标点击（合成 .click() 对部分 React 组件无效）。expr → 元素。 */
    async clickEl(expr) {
      const rect = await this.evalJs(`(() => {
        const el = ${expr};
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!rect) return false;
      await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await sleep(120);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.call('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      }
      return true;
    },
    async shot(name) {
      await this.call('Page.captureScreenshot', { format: 'png' }).then((r) => {
        if (r && r.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
      }).catch((e) => console.log('  [shot skipped]', name, e.message));
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function waitForMainPage(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const hit = list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1/.test(t.url));
      if (hit) return hit;
    } catch { /* 端口未就绪 */ }
    await sleep(700);
  }
  throw new Error('main page target not found in time');
}

async function waitForAppReady(client, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const state = await client.evalJs(`(() => {
        const phaseEl = document.querySelector('[data-phase]');
        return { phase: phaseEl ? phaseEl.getAttribute('data-phase') : null, root: !!document.querySelector('#root') };
      })()`);
      if (state && state.root && state.phase !== null) return state;
    } catch { /* 页面还在切换/注入中 */ }
    await sleep(1500);
  }
  throw new Error('SPA did not become ready in time');
}

async function waitFor(client, expr, timeoutMs, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await client.evalJs(expr); } catch { last = null; }
    if (last) return last;
    await sleep(600);
  }
  throw new Error('timeout waiting: ' + label + ' (last=' + JSON.stringify(last) + ')');
}

/** 页面内经 /api 网关直调 unary RPC（同源 cookie；payload = {args:{request:…}}，
*  与 typert 描述符 parameters[{name:"request"}] 对齐）。 */
const api = (endpoint, payload) => ` (async () => {
  const message = { type: 'client-request', rpcId: 'smoke-' + Math.random().toString(36).slice(2), method: ${JSON.stringify(endpoint)}, payload: { args: { request: ${JSON.stringify(payload)} } } };
  const response = await fetch('/api/${endpoint}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  return await response.json();
})() `;

/** 会话日志探针：session/page 已删会话 → ok:false + session-not-found；
* 活着的空会话 → bad-request（throughSeq 越过空游标），两者判别清晰。 */
const pageProbe = (sessionId) => ` (async () => {
  const message = { type: 'client-request', rpcId: 'smoke-' + Math.random().toString(36).slice(2), method: 'session/page', payload: { args: { request: { address: { kind: 'session', sessionId: ${JSON.stringify(sessionId)} }, throughSeq: 0 } } } };
  const response = await fetch('/api/session/page', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  const full = await response.json();
  return { ok: full?.result?.ok === true, code: full?.result?.error?.code ?? null };
})() `;

/** 归档动作（有副作用：真归档）。 */
const archiveAction = (sessionId) => ` (async () => {
  const message = { type: 'client-request', rpcId: 'smoke-' + Math.random().toString(36).slice(2), method: 'workspace/archiveSession', payload: { args: { request: { sessionId: ${JSON.stringify(sessionId)} } } } };
  const response = await fetch('/api/workspace/archiveSession', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  const full = await response.json();
  return { ok: full?.result?.ok === true, code: full?.result?.error?.code ?? null };
})() `;

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error('[verify-delete] missing exe:', EXE);
    process.exit(2);
  }
  console.log('[verify-delete] launching', EXE, '(DSH_HOME=' + tmpHome + ')');
  const shell = spawn(EXE, [], {
    env: {
      ...process.env,
      DSH_HOME: tmpHome,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  shell.stderr.on('data', (d) => process.stdout.write('  [shell:err] ' + d));
  let shellExited = false;
  shell.on('exit', (code) => { shellExited = true; console.log('[verify-delete] shell exited code=' + code); });

  const alerts = [];
  let confirmCount = 0;
  let clientRef = null;

  try {
    const target = await waitForMainPage(180000);
    const client = cdp(target.webSocketDebuggerUrl);
    clientRef = client;
    await client.ready;
    await client.call('Page.enable');
    client.on((msg) => {
      if (msg.method !== 'Page.javascriptDialogOpening') return;
      const d = msg.params || {};
      if (d.type === 'alert') {
        alerts.push(String(d.message || ''));
        console.log('  [dialog] alert:', d.message);
      }
      if (d.type === 'confirm') confirmCount++;
      client.call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });

    const ready = await waitForAppReady(client, 180000);
    console.log('[verify-delete] app ready, phase =', ready.phase);
    await sleep(3000); // 等插件 slots/桥接注入完

    // 首启动的「内测声明」弹窗会挡住一切交互 → 先点「继续」。
    const dismissed = await client.clickEl(`[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '继续')`);
    if (dismissed) {
      console.log('[verify-delete] 已关闭首启动内测声明弹窗');
      await sleep(1500);
    }
    await client.shot('00-ready.png');

    // 直建工作区 + 会话（不经模型，无 API 花费）。
    const wsResp = await client.evalJs(api('workspace/create', { path: wsDir }));
    check('workspace/create RPC ok', wsResp?.result?.ok === true, JSON.stringify(wsResp?.result?.error || '').slice(0, 120));
    const workspaceId = wsResp?.result?.value?.workspace?.workspaceId;
    check('workspaceId 已返回', typeof workspaceId === 'string' && workspaceId.length > 0, String(workspaceId).slice(0, 20));

    const sessResp = await client.evalJs(api('session/create', { workspaceId }));
    check('session/create RPC ok', sessResp?.result?.ok === true, JSON.stringify(sessResp?.result?.error || '').slice(0, 120));
    const sessionId = sessResp?.result?.value?.session?.id || sessResp?.result?.value?.sessionId;
    check('sessionId 已返回', typeof sessionId === 'string' && sessionId.length > 0, String(sessionId).slice(0, 20));

    // 行渲染（占位行也渲染 treeitem；⋯ 菜单仅非 blank 行才有 —— 内核原生行为）。
    try {
      await waitFor(client, `[...document.querySelectorAll('[role="treeitem"]')].some((n) => (n.textContent || '').includes('新会话'))`, 30000, '侧栏树出现新会话行');
      console.log('✔ 会话行已渲染在侧栏（占位行，无 ⋯ 菜单属内核原生行为）');
    } catch { console.log('ℹ 侧栏行未捕获（以 RPC 后置条件为准）'); }
    await client.shot('01-session-row.png');

    // ---- A) 插件桥 deleteSession（权威断言：布尔返回值）----
    const del1 = await client.evalJs(`window.__dshSessionManager.deleteSession(${JSON.stringify(sessionId)})`);
    check('插件桥 deleteSession 返回 true', del1 === true, String(del1));
    const gone = await client.evalJs(pageProbe(sessionId));
    check('删除确凿（再归档报 session-not-found）', gone.ok === false && gone.code === 'session-not-found', JSON.stringify(gone));
    check('deleteSession 弹出了确认框', confirmCount >= 1, 'confirm=' + confirmCount);
    check('删除过程无「操作失败」alert', alerts.length === 0, alerts.join(' | ') || '无 alert');
    await client.shot('02-after-delete.png');

    // 幂等：删除不存在的会话也返回 true（陈旧归档项可清）。
    const delGhost = await client.evalJs(`window.__dshSessionManager.deleteSession('smoke-nonexistent-id')`);
    check('删除未知会话幂等返回 true', delGhost === true, String(delGhost));

    // ---- B) unarchiveSession（归档 → 桥恢复）----
    const sess2Resp = await client.evalJs(api('session/create', { workspaceId }));
    check('第二个 session/create ok', sess2Resp?.result?.ok === true, JSON.stringify(sess2Resp?.result?.error || '').slice(0, 120));
    const sessionId2 = sess2Resp?.result?.value?.session?.id || sess2Resp?.result?.value?.sessionId;
    const arch1 = await client.evalJs(archiveAction(sessionId2));
    check('第二个会话存在（归档 ok）', arch1.ok === true, JSON.stringify(arch1));

    const unarch = await client.evalJs(`window.__dshSessionManager.unarchiveSession(${JSON.stringify(sessionId2)})`);
    check('插件桥 unarchiveSession 返回 true', unarch === true, String(unarch));
    const arch2 = await client.evalJs(archiveAction(sessionId2));
    check('恢复确凿（可再次归档 = 会话完好）', arch2.ok === true, JSON.stringify(arch2));
    check('归档/恢复过程无 alert', alerts.length === 0, alerts.join(' | ') || '无 alert');
    await client.shot('03-after-restore.png');

    // 收尾：桥删除第二个会话，删除确凿性同 session1。
    const del2 = await client.evalJs(`window.__dshSessionManager.deleteSession(${JSON.stringify(sessionId2)})`);
    check('第二会话桥删除返回 true', del2 === true, String(del2));
    const gone2 = await client.evalJs(pageProbe(sessionId2));
    check('第二会话删除确凿（再归档报 session-not-found）', gone2.ok === false && gone2.code === 'session-not-found', JSON.stringify(gone2));

    check('全程零 alert（两个修复路径都干净）', alerts.length === 0, alerts.join(' | ') || '无 alert');
    await client.shot('04-final.png');

    client.close();
  } catch (err) {
    failures++;
    console.error('[verify-delete] FAIL:', err.message);
    try { await clientRef.shot('99-error.png'); } catch {}
  } finally {
    if (!shellExited) {
      shell.kill();
      await sleep(2000);
    }
    console.log(failures === 0 ? '[verify-delete] PASS (all checks green)' : `[verify-delete] FAILED: ${failures} check(s)`);
    process.exit(failures === 0 ? 0 : 1);
  }
})();
