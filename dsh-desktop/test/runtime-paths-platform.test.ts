import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimePaths = require('../lib/desktop/runtime-paths.js') as {
  APP_ROOT: string;
  init(ctx: {
    log(tag: string, message: string): void;
    getUserDataDir(): string;
    isPackaged(): boolean;
    resourcesPath(): string;
    platform: NodeJS.Platform;
  }): void;
  nodeExe(): string;
};

test('runtime paths resolve the packaged Node executable for Linux', () => {
  const appRoot = path.join('', 'tmp', 'dsh-app-root');
  runtimePaths.init({
    log: () => {},
    getUserDataDir: () => '/tmp/user-data',
    isPackaged: () => true,
    resourcesPath: () => '/opt/dsh',
    appRoot: () => appRoot,
    platform: 'linux',
  });

  // appRoot 指向空目录 → Tauri 布局缺失，命中旧 Electron 布局回退候选。
  assert.equal(runtimePaths.nodeExe(), path.join('/opt/dsh', 'node', 'node'));
});

test('runtime paths preserve packaged and development node.exe on Windows', { skip: process.platform !== 'win32' }, () => {
  // 5.3.3：打包态优先 Tauri 布局（appRoot/vendor/node —— 打包态 appRoot =
  // <DSH_RESOURCE_ROOT>/dsh-desktop）；旧 Electron 布局 resources/node/ 仅作
  // 回退候选（上方 Linux 用例覆盖回退分支）。win32 上仓库树
  // vendor/node/node.exe 真实存在 → 打包态与开发态解析到同一路径。
  runtimePaths.init({
    log: () => {},
    getUserDataDir: () => 'C:\\tmp\\user-data',
    isPackaged: () => true,
    resourcesPath: () => 'C:\\Program Files\\DSH',
    platform: 'win32',
  });
  assert.equal(runtimePaths.nodeExe(), path.resolve(runtimePaths.APP_ROOT, 'vendor', 'node', 'node.exe'));

  runtimePaths.init({
    log: () => {},
    getUserDataDir: () => 'C:\\tmp\\user-data',
    isPackaged: () => false,
    resourcesPath: () => '',
    platform: 'win32',
  });
  assert.equal(runtimePaths.nodeExe(), path.resolve(runtimePaths.APP_ROOT, 'vendor', 'node', 'node.exe'));
});
