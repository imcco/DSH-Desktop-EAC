import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  copyKernelCacheForTarget,
  sanitizeClientBuildPaths,
} from '../../tauri-shell/stage-linux-sanitize.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shell = readFileSync(join(root, 'tauri-shell', 'src', 'main.rs'), 'utf8');
const rescue = readFileSync(join(root, 'tauri-shell', 'sidecar', 'rescue-integration.ts'), 'utf8');
const patchDeps = readFileSync(join(root, 'dsh-desktop', 'scripts', 'patch-deps.ts'), 'utf8');
const release = readFileSync(join(root, '.github', 'workflows', 'release-tauri.yml'), 'utf8');
const windowsRelease = release.split('release-tauri-linux:')[0] || '';
const linuxRelease = release.split('release-tauri-linux:')[1] || '';

test('Tauri setup initializes the packaged resource root before spawning the sidecar', () => {
  assert.match(shell, /app\.path\(\)\.resource_dir\(\)/);
  const setup = shell.indexOf('.setup(move |app|');
  const initialize = shell.indexOf('initialize_packaged_resource_root(app)', setup);
  const spawn = shell.indexOf('Sidecar::spawn().await', setup);
  assert.ok(setup >= 0 && initialize > setup && spawn > initialize,
    'resource_dir must be initialized before the packaged sidecar starts');
});

test('rescue integration resolves both source and packaged sidecar layouts', () => {
  assert.match(rescue, /path\.resolve\(sidecarDir, '\.\.', '\.\.', 'dsh-desktop'\)/);
  assert.match(rescue, /path\.resolve\(sidecarDir, '\.\.', 'dsh-desktop'\)/);
  assert.match(rescue, /resolveDesktopRoot\(\)/);
});

test('Linux releases rebuild the kernel cache from a clean checkout', () => {
  assert.match(linuxRelease, /准备内核依赖缓存[\s\S]*pnpm@11\.7\.0[\s\S]*fetch-kernel\.js/);
});

test('Windows releases rebuild the kernel cache before installing dependencies', () => {
  assert.match(
    windowsRelease,
    /缓存 vendored 内核 tarball[\s\S]*pnpm@11\.7\.0[\s\S]*fetch-kernel\.js[\s\S]*安装依赖[\s\S]*ci:install/,
  );
});

test('Windows releases fetch Tauri crates before staging WebView2Loader.dll', () => {
  const fetchTauriCrates = windowsRelease.indexOf('cargo fetch --locked --target x86_64-pc-windows-msvc');
  const stageResources = windowsRelease.indexOf('node ../tauri-shell/stage-resources.mjs');
  assert.ok(fetchTauriCrates >= 0, 'Windows release must fetch the locked Tauri dependency graph');
  assert.ok(stageResources > fetchTauriCrates, 'Tauri crates must be available before resources are staged');
});

test('all staging targets exclude the kernel build tree and remove client build paths', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-linux-stage-'));
  try {
    const kernel = join(temp, 'kernel');
    const stagedKernel = join(temp, 'staged-kernel');
    mkdirSync(join(kernel, '.build'), { recursive: true });
    mkdirSync(join(kernel, '0.1.2-alpha.1'), { recursive: true });
    writeFileSync(join(kernel, '.build', 'source.txt'), 'must not ship');
    writeFileSync(join(kernel, '0.1.2-alpha.1', 'package.tgz'), 'tarball');
    copyKernelCacheForTarget(kernel, stagedKernel, 'linux');
    assert.equal(existsSync(join(stagedKernel, '.build')), false);
    assert.equal(existsSync(join(stagedKernel, '0.1.2-alpha.1', 'package.tgz')), true);

    const stagedWindowsKernel = join(temp, 'staged-windows-kernel');
    copyKernelCacheForTarget(kernel, stagedWindowsKernel, 'win32');
    assert.equal(existsSync(join(stagedWindowsKernel, '.build')), false);
    assert.equal(existsSync(join(stagedWindowsKernel, '0.1.2-alpha.1', 'package.tgz')), true);

    const client = join(temp, 'node_modules', '@deepseek-ai', 'example', 'lib', 'client.js');
    mkdirSync(join(temp, 'node_modules', '@deepseek-ai', 'example', 'lib'), { recursive: true });
    writeFileSync(client, [
      '//#region \\0dsh-css:/home/runner/work/repo/dsh-desktop/vendor/kernel/.build/deepseek-harness-dsh-v0.1.2-alpha.1/packages/example/src/client.css.mjs',
      '//#region \\0dsh-css:D:\\build\\dsh-desktop\\vendor\\kernel\\.build\\deepseek-harness-dsh-v0.1.2-alpha.1\\packages\\example\\src\\client.css.mjs',
      '//#region \\0dsh-inline-css:/home/runner/work/repo/dsh-desktop/vendor/kernel/.build/deepseek-harness-dsh-v0.1.2-alpha.1/packages/example/src/base.css.mjs',
      'const value = 1;',
    ].join('\n'));
    assert.equal(sanitizeClientBuildPaths(join(temp, 'node_modules')), 1);
    const sanitized = readFileSync(client, 'utf8');
    assert.doesNotMatch(sanitized, /\/home\/runner/);
    assert.doesNotMatch(sanitized, /D:\\build/);
    assert.match(sanitized, /\\0dsh-css:deepseek-harness-dsh-v0\.1\.2-alpha\.1\/packages\/example/);
    assert.match(sanitized, /\\0dsh-inline-css:deepseek-harness-dsh-v0\.1\.2-alpha\.1\/packages\/example/);
    assert.equal(sanitizeClientBuildPaths(join(temp, 'node_modules')), 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('client modules preserve the distinct Node 22 and Node 24 resolver signatures', async () => {
  assert.match(patchDeps, /internal\.version === "v2" \? internal\.resolveSync\(baseUrl, \{/);
  const installed = readFileSync(
    join(root, 'dsh-desktop', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'),
    'utf8',
  );
  assert.match(installed, /internal\.version === "v2" \? internal\.resolveSync\(baseUrl, \{/);
  assert.match(installed, /specifier: loaderName/);

  const loaderPackage = await import('@deepseek-ai/cordis-plugin-loader') as unknown as {
    ModuleLoader: {
      fromInternal(): {
        version: 'v1' | 'v2';
        resolveSync(...args: unknown[]): { url: string };
      } | undefined;
    };
  };
  const loader = loaderPackage.ModuleLoader.fromInternal();
  assert.ok(loader, `Node ${process.version} must expose the internal module resolver`);
  const parentUrl = pathToFileURL(join(root, 'dsh-desktop', 'package.json')).href;
  const specifier = '@deepseek-ai/dsh-client-modules';
  const resolved = loader.version === 'v2'
    ? loader.resolveSync(parentUrl, { specifier, attributes: {} })
    : loader.resolveSync(specifier, parentUrl, {});
  assert.match(resolved.url, /dsh-client-modules/);
});
