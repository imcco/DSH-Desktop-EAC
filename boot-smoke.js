'use strict';
// P2 boot.start 冒烟驱动（一次性）：在临时 DSH_HOME、用户主目录与
// APPDATA/LOCALAPPDATA/XDG 配置边界下完整走前置准备 → spawn dsh web →
// webUrl → HTTP 探活 → 优雅关停，绝不读取或改写真实用户数据。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const isolatedRoot = path.join(repo, 'tmp-p2boot', 'boot-isolated');
const tmpHome = path.join(isolatedRoot, 'dsh-home');
const tmpAppData = path.join(isolatedRoot, 'appdata');
const tmpLocalAppData = path.join(isolatedRoot, 'localappdata');
const tmpXdgConfig = path.join(isolatedRoot, 'xdg-config');
const tmpProfile = path.join(isolatedRoot, 'home');
const tmpUserData = process.platform === 'win32'
  ? path.join(tmpAppData, 'Deepseek Harness EAC')
  : process.platform === 'darwin'
    ? path.join(tmpProfile, 'Library', 'Application Support', 'deepseek-harness-eac')
    : path.join(tmpXdgConfig, 'deepseek-harness-eac');
fs.rmSync(isolatedRoot, { recursive: true, force: true });
for (const dir of [tmpHome, tmpAppData, tmpLocalAppData, tmpXdgConfig, tmpProfile, tmpUserData]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify({ pluginOnboardingDone: true }, null, 2));
const isolatedEnv = {
  ...process.env,
  DSH_HOME: tmpHome,
  HOME: tmpProfile,
  USERPROFILE: tmpProfile,
  APPDATA: tmpAppData,
  LOCALAPPDATA: tmpLocalAppData,
  XDG_CONFIG_HOME: tmpXdgConfig,
  DSH_DESKTOP_SKIP_AUTO_UPDATE: '1',
  DSH_DESKTOP_SKIP_CLIENT_UPDATE: '1',
  DSH_DESKTOP_SKIP_AGENT_UPDATE: '1',
  DSH_DESKTOP_SKIP_PLUGIN_UPDATE: '1',
  DSH_DESKTOP_TEST_NO_SHORTCUTS: '1',
};

const resourceRoot = process.env.DSH_SMOKE_RESOURCE_ROOT;
const node = process.env.DSH_SMOKE_NODE || (resourceRoot
  ? path.join(resourceRoot, 'dsh-desktop', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  : process.execPath);
const sidecar = process.env.DSH_SMOKE_SIDECAR || (resourceRoot
  ? path.join(resourceRoot, 'sidecar', 'server.js')
  : path.join(repo, 'tauri-shell', 'sidecar', 'server.js'));
const child = spawn(node, [sidecar], {
  env: { ...isolatedEnv, ...(resourceRoot ? { DSH_RESOURCE_ROOT: resourceRoot } : {}) },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const t0 = Date.now();
const fail = (msg) => { console.error('[boot-smoke] FAIL:', msg); child.kill(); process.exit(1); };
const timer = setTimeout(() => fail('总超时 300s'), 300000);

function probe(url, cookies = [], redirects = 0) {
  http.get(url, {
    timeout: 5000,
    headers: cookies.length ? { Cookie: cookies.join('; ') } : {},
  }, (r) => {
    r.resume();
    const nextCookies = cookies.concat((r.headers['set-cookie'] || []).map((value) => value.split(';', 1)[0]));
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 5) {
      return probe(new URL(r.headers.location, url).toString(), nextCookies, redirects + 1);
    }
    console.log('[boot-smoke] probe status =', r.statusCode, 'redirects =', redirects);
    if (r.statusCode !== 200) return fail('probe status: ' + r.statusCode);
    clearTimeout(timer);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }) + '\n');
    setTimeout(() => { console.log('[boot-smoke] PASS'); child.kill(); process.exit(0); }, 9000);
  }).on('error', (e) => fail('probe error: ' + e.message));
}

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1 && msg.result && msg.result.webUrl) {
      const url = msg.result.webUrl;
      console.log('[boot-smoke] boot.start ok in', Math.round((Date.now() - t0) / 1000) + 's →', url);
      probe(url);
    } else if (msg.id === 1 && msg.error) {
      fail('boot.start error: ' + JSON.stringify(msg.error));
    } else if (msg.method === 'boot.web-ready') {
      console.log('[boot-smoke] notify boot.web-ready:', JSON.stringify(msg.params));
    }
  }
});

setTimeout(() => {
  console.log('[boot-smoke] sending boot.start (DSH_HOME=' + tmpHome + ')');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'boot.start', params: {} }) + '\n');
}, 500);
child.on('exit', (code) => { console.log('[boot-smoke] sidecar exited code=' + code); });
