'use strict';
// 视口失同步自愈冒烟（5.3.4 修复回归）：
//  T1 健康心跳不误报：启动后静置 12s，壳层不得打印 viewport desync
//  T2 伪造窄视口心跳（166×815@1.25）→ 壳层打印 desync 并重申 webview bounds，
//     页面不崩溃、innerWidth 不变（窗口尺寸 ≠ 页面视口的失同步被检测）
//  T3 连续第二拍 → 升级 1px 往返（非最大化），往返后 innerWidth 复位（±2px）
//  T4 src=float 的伪造报文不触发自愈（浮窗比对不适用）
// 用法: node verify-viewport-heal.js [exePath]  （默认 target/debug，DSH_SMOKE_EXE 亦可）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-viewport-heal', 'home');
fs.mkdirSync(tmpHome, { recursive: true });
const CDP_PORT = 9341;
const WS_PORT = 19873;
const EXE = process.env.DSH_SMOKE_EXE || process.argv[2]
  || path.join(repo, 'tauri-shell', 'target', 'debug', 'dsh-eac-shell.exe');

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

(async () => {
  try { await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/version`); console.log('⚠ 端口占用，先杀旧实例'); } catch {}
  try { spawn('taskkill', ['/im', 'dsh-eac-shell.exe', '/f'], { stdio: 'ignore' }); await sleep(1500); } catch {}

  console.log('[smoke] launching', EXE);
  const shell = spawn(EXE, [], {
    env: { ...process.env, DSH_HOME: tmpHome, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + CDP_PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let shellErr = '';
  shell.stderr.on('data', (d) => { shellErr += String(d); });
  shell.stdout.on('data', (d) => { shellErr += String(d); });

  try {
    // 等 CDP + 侧边栏挂载
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(1000);
      try {
        const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        page = list.filter((t) => t.type === 'page' && (t.url || '').includes('127.0.0.1'))[0] || null;
      } catch {}
    }
    if (!page) throw new Error('no CDP page target; shell out:\n' + shellErr.slice(-1500));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let seq = 0; const pend = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); });
    const call = (method, params) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
    const evalJs = async (expr) => {
      const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    };
    let booted = false;
    for (let i = 0; i < 90; i++) { try { if (await evalJs('!!document.querySelector("[data-slot=sidetebar]") || !!document.querySelector("[data-slot=\'sidebar\']")')) { booted = true; break; } } catch {} await sleep(1000); }
    check('应用启动且侧边栏挂载', booted);
    if (!booted) throw new Error('app not booted');

    // T1 健康心跳 12s 无误报
    const markT1 = shellErr.length;
    await sleep(12000);
    const t1 = shellErr.slice(markT1);
    check('T1 健康心跳无误报', !t1.includes('viewport desync'), t1.includes('viewport desync') ? '出现误报' : '');

    const baseInner = await evalJs('({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })');
    console.log('[smoke] page viewport', JSON.stringify(baseInner));

    // 伪造心跳用的原始 WS 客户端
    const raw = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws`);
    await new Promise((res, rej) => { raw.onopen = res; raw.onerror = () => rej(new Error('bridge ws error')); });
    const notify = (method, params) => raw.send(JSON.stringify({ jsonrpc: '2.0', method, params }));

    // T2 单拍伪造 → desync 检测 + set_bounds 重申
    const markT2 = shellErr.length;
    notify('win.viewport-beat', { w: 166, h: 815, dpr: 1.25, src: 'main' });
    // 等壳层完成 T2 自愈（LAST_VP_HEAL 落在此刻），再恰好压过 2s 节流发
    // 第二拍：页面自身每 5s 的健康拍会把 desync 连胜清零（可见窗口下
    // WebView2 不节流 setInterval），第二拍若拖到 5.7s 后几乎必被健康拍
    // 抢先重置（T3 曾因此时序敏感间歇失败）——提前到 ~4.4s，卡在节流窗
    // 外、健康拍（+5s 相位）前。
    await sleep(2200);
    const t2 = shellErr.slice(markT2);
    check('T2 伪造窄视口被检出', t2.includes('viewport desync') && t2.includes('re-asserting'), t2.split('\n').find((l) => l.includes('viewport')) || '无日志');
    const afterT2 = await evalJs('({ w: window.innerWidth, h: window.innerHeight })');
    check('T2 页面存活且视口未受扰动', afterT2.w === baseInner.w && afterT2.h === baseInner.h, JSON.stringify(afterT2));

    // T3 连续第二拍 → 1px 往返（非最大化）后复位。
    // 时序说明：页面自身每 5s 的健康拍会把壳层 desync 连胜清零，而升级
    // （nudge）要求「连续两拍 desync 且都压过 2s 节流」——仿真拍若与健康
    // 拍相位相撞则连胜被重置，属测试仿真的固有竞态（真实失同步时页面
    // 视口卡死，根本发不出健康拍）。以重试吸收相位：最多 4 轮，每轮两拍
    // 间隔 2.3s（过节流、大概率避开 +5s 健康拍相位）。
    let nudged = '';
    for (let attempt = 0; attempt < 4 && !nudged; attempt++) {
      notify('win.viewport-beat', { w: 166, h: 815, dpr: 1.25, src: 'main' });
      await sleep(2300);
      const markT3 = shellErr.length;
      notify('win.viewport-beat', { w: 166, h: 815, dpr: 1.25, src: 'main' });
      await sleep(1500);
      nudged = shellErr.slice(markT3).split('\n').find((l) => l.includes('nudged')) || '';
    }
    check('T3 升级为窗口尺寸往返', !!nudged, nudged || '四轮仿真均未升级（健康拍相位连撞，时序敏感项）');
    await sleep(1200);
    const afterT3 = await evalJs('({ w: window.innerWidth, h: window.innerHeight })');
    check('T3 往返后窗口尺寸复位', Math.abs(afterT3.w - baseInner.w) <= 2 && Math.abs(afterT3.h - baseInner.h) <= 2, JSON.stringify(afterT3));

    // T4 浮窗来源报文不触发
    const markT4 = shellErr.length;
    notify('win.viewport-beat', { w: 111, h: 222, dpr: 1, src: 'float' });
    await sleep(2500);
    check('T4 浮窗报文不触发自愈', !shellErr.slice(markT4).includes('viewport desync'), '');

    raw.close(); ws.close();
  } finally {
    try { spawn('taskkill', ['/pid', String(shell.pid), '/f', '/t'], { stdio: 'ignore' }); } catch {}
  }
  console.log(failures === 0 ? '[smoke] ALL PASS' : `[smoke] FAILED: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('[smoke] FAIL:', e.message); process.exit(1); });
