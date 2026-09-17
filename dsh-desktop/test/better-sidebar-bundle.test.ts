// TDD acceptance tests for bundling the upstream dsh-better-sidebar plugin
// (VSCode-like right sidebar: explorer / editor / terminal / git views).
//
// Distribution model (same as dsh-tool-vision & friends):
//   - plugin package vendored under assets/plugins/dsh-better-sidebar
//     (prebuilt lib/, no TS sources needed at runtime)
//   - registered in COMPANION_PLUGINS so syncCompanionPlugins copies it into
//     the web profile node_modules and mounts it via the overlay patch row
//   - its only server-side dependency outside the app closure (schemastery)
//     must be declared in package.json so the fallback junctions can serve it

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PLUGIN = join(ROOT, 'assets', 'plugins', 'dsh-better-sidebar');

test('dsh-better-sidebar plugin package is vendored with prebuilt lib', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'dsh.plugin.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-better-sidebar');
  assert.equal(pkg.version, '0.15.3-eac.2',
    'EAC must ship the patched 0.15.2-compatible build above the broken upstream version');
  assert.equal(manifest.version, pkg.version, 'EAC plugin manifest version must match package.json');
  assert.ok(existsSync(join(PLUGIN, 'lib', 'index.js')), 'server entry lib/index.js missing');
  assert.ok(existsSync(join(PLUGIN, 'lib', 'client-registry.js')), 'client entry missing');
  assert.ok(existsSync(join(PLUGIN, 'LICENSE')), 'LICENSE must ship with the plugin');
});

test('dsh-better-sidebar server entry only requires deps available in the app closure', () => {
  const src = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
  const specs = [...src.matchAll(/from\s+["']([^"'.][^"']*)["']/g)].map((m) => m[1]);
  const external = specs.filter((s) => !s.startsWith('node:'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const closure = new Set([
    ...Object.keys(pkg.dependencies || {}),
    'ws', 'node-pty', 'clsx', // transitive deps already vendored in the closure
  ]);
  for (const s of external) {
    const ok = closure.has(s) || s.startsWith('@deepseek-ai/');
    assert.ok(ok, `lib/index.js imports "${s}" which is not in the app closure`);
  }
});

test('schemastery (the plugin\'s only missing server dep) is declared', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies && pkg.dependencies.schemastery,
    'schemastery must be in dependencies for fallback junction resolution');
});

test('desktop profile initialization resolves the DSH home before linking schemastery', () => {
  // ADR 0002：实现迁至 lib/desktop/profile（L2 业务服务层；Wave 1 起 .ts 为源）。
  const src = readFileSync(join(ROOT, 'lib', 'desktop', 'profile.ts'), 'utf8');
  const start = src.indexOf('function ensureDesktopProfileInit()');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  assert.match(body, /const home = ctx\.getDshHome\(\) \|\| path\.join\(os\.homedir\(\), '\.dsh'\)/,
    'ensureDesktopProfileInit must define home before path.join(home, ...)');
  assert.match(body, /path\.join\(home, 'profiles', 'node_modules'\)/);
});

// issue #14 / zcode 报告：app 层声明不足以让 fallback 闭包（BFS 起点是
// 捆绑的 dsh 包 package.json）包含 schemastery → 全新安装后
// profiles/node_modules 永远缺 junction → dsh web 启动即崩（退出码 1）。
// Electron 时代由 after-pack 的 injectDshClosureExtras 注入闭包外依赖；
// after-pack 已随壳退役（批次 C），Tauri 链的无争议等价保证 = 声明即实装：
// schemastery 声明在 dependencies 且已解析进 node_modules，stage npm ci 会把
// 整个闭包（含 schemastery）装进安装包，fallback junction BFS 每次启动幂等维护。
test('schemastery 在运行时闭包中可解析（声明 + node_modules 实装）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies && pkg.dependencies.schemastery,
    'schemastery must be in dependencies for fallback junction resolution');
  assert.ok(existsSync(join(ROOT, 'node_modules', 'schemastery', 'package.json')),
    'schemastery 未实装进 node_modules（stage npm ci 将据此进安装包）');
});

test('COMPANION_PLUGINS registers dsh-better-sidebar with a fresh-install open default', () => {
  // ADR 0002：注册表迁至 lib/desktop/companion-sync.js。
  const mainSrc = readFileSync(join(ROOT, 'lib', 'desktop', 'companion-sync.ts'), 'utf8');
  assert.match(
    mainSrc,
    /\{\s*id:\s*'better-sidebar',\s*name:\s*'dsh-better-sidebar',\s*dir:\s*'dsh-better-sidebar',\s*config:\s*\{\s*openByDefault:\s*true\s*\}\s*\}/,
    'newly generated profile rows must opt into opening the sidebar',
  );
  const existingRowGuard = mainSrc.indexOf('if (hasEntryId(patch, p.id)) continue;');
  const configWrite = mainSrc.indexOf('block += configLinesFor(p.config)');
  assert.ok(existingRowGuard >= 0 && configWrite > existingRowGuard,
    'existing profile rows must be kept before new-row config is serialized');
});

test('vendored plugin ships without TypeScript sources (installer size)', () => {
  assert.equal(existsSync(join(PLUGIN, 'src')), false, 'src/ must not ship in the installer');
});

test('fresh-install open default composes below user settings without changing legacy defaults', () => {
  const serverSrc = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
  assert.match(serverSrc, /const Config = z\.object\(\{\s*openByDefault:\s*z\.boolean\(\)\.default\(false\)/,
    'deployment config must default false so existing profile rows keep their behavior');
  assert.match(serverSrc, /openByDefault:\s*config\?\.openByDefault\s*\?\?\s*false/,
    'direct callers without the new profile config must keep the legacy default');
  assert.match(
    serverSrc,
    /sctx\.settings\.register\(ns,\s*PrefsSchema,\s*\{\s*base:\s*\{\s*openByDefault:\s*resolved\.openByDefault\s*\}\s*\}\)/,
    'fresh-install config must be a settings base that explicit user values can override',
  );
  assert.match(serverSrc, /const PrefsSchema = z\.object\(\{\s*openByDefault:\s*z\.boolean\(\)\.default\(false\)/,
    'server preference schema must default openByDefault to false');

  for (const entry of ['client.js', 'client-registry.js']) {
    const src = readFileSync(join(PLUGIN, 'lib', entry), 'utf8');
    assert.match(src, /const SIDEBAR_PREFS_DEFAULTS = \{\s*openByDefault:\s*false,/,
      `${entry} fallback preferences must keep the sidebar closed`);
    assert.match(src, /const HOST_SIDEBAR_AUTO_COLLAPSE = 1024;/,
      `${entry} must track the host sidebar auto-collapse breakpoint`);
    assert.match(src, /return viewport - panelWidth >= HOST_SIDEBAR_AUTO_COLLAPSE;/,
      `${entry} must preserve enough width for the host layout`);
    assert.match(src, /panelOpen: record\.panelOpen && \(viewport === void 0 \|\| canRestorePanel\(viewport, width\)\)/,
      `${entry} must guard persisted open states during session switches`);
  }
});

test('lazy client chunks use the injected module system with a legacy global fallback', () => {
  for (const entry of ['client.js', 'client-registry.js']) {
    const src = readFileSync(join(PLUGIN, 'lib', entry), 'utf8');
    assert.match(src, /return injectedModuleSystem \?\? g\[MODULE_SYSTEM_GLOBAL\] \?\? g\.__DSH_MODULES__/,
      `${entry} must prefer the injected module system and retain the legacy page global`);
    assert.match(src, /setChunkModuleSystem\(ctx\.modules\)/,
      `${entry} must inject the current DSH client module system before loading chunks`);
    assert.match(src, /client module system unavailable/,
      `${entry} must retain an actionable error when no module system exists`);
  }
});

test('file previews can return to Files and crashed tabs retain recovery actions', () => {
  for (const entry of ['client.js', 'client-registry.js']) {
    const src = readFileSync(join(PLUGIN, 'lib', entry), 'utf8');
    assert.match(src, /backToFiles:\s*"返回文件列表"/,
      `${entry} must ship the localized back-to-files action`);
    assert.match(src, /function returnEditorTabToFiles\(ctx,\s*tab,\s*scope\)/,
      `${entry} must centralize normal and crash recovery behavior`);
    assert.match(src, /candidate\.id !== tab\.id && candidate\.type === "editor" && \(candidate\.path === void 0 \|\| candidate\.path === ""\)/,
      `${entry} must reuse an existing Files tab when one is already open`);
    assert.match(src, /service\.closeTab\(tab\.id,\s*scope\);\s*service\.activateTab\(existing\.id,\s*scope\)/,
      `${entry} must close the preview and focus the existing Files tab`);
    assert.match(src, /service\.updateTab\(tab\.id,\s*\{\s*path:\s*"",\s*title:\s*"Files"/,
      `${entry} must fall back to restoring the current editor tab`);
    assert.match(src, /onRecover:\s*recoverFileTab/,
      `${entry} must expose a per-tab recovery action`);
    assert.match(src, /onClose:\s*\(\)\s*=>\s*ctx\.betterSidebar\?\.closeTab\(tab\.id,\s*scope\)/,
      `${entry} must let the render boundary close the crashed tab`);
  }
});

test('markdown previews pass both rc.8 and alpha.1 label contracts', () => {
  for (const entry of ['client.js', 'client-registry.js', 'client-editor.js', 'client-mermaid.js']) {
    const src = readFileSync(join(PLUGIN, 'lib', entry), 'utf8');
    assert.match(src, /footnotes:\s*"脚注"/,
      `${entry} must ship a footnote label for the alpha.1 MarkdownText contract`);
    assert.match(src, /labels:\s*\{\s*code:\s*(?:codeLabels|labels),\s*footnotes:\s*t\("footnotes"\)\s*\}/,
      `${entry} must pass the alpha.1 MarkdownText labels object`);
    assert.match(src, /codeLabels:\s*(?:codeLabels|labels)/,
      `${entry} must retain the rc.8 MarkdownText codeLabels prop`);
  }
});
