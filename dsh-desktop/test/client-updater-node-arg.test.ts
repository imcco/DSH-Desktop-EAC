// v4.4（PR79 集成回归）：applyUpdate 必须把应用自带的 node.exe 经隐藏
// PowerShell 的 Unicode 参数链传给 apply-update.cmd。
//
// manifest.json 的生成（备份分支）需要执行一段内联 JS。目标用户机器普遍
// 没有系统 Node —— 脚本必须用打包在 resources\node\node.exe 的运行时
// 路径，绝不能裸调 PATH 上的 node（errorlevel 9009 → BAD=2 → 更新永远
// 中止回滚，与 v3.0.1 自举陷阱同类）。
//
// nodeExe 正好是批处理第 9 参，可用 %~9 安全读取；不能改成第 10 参，
// 因为 `%~10` 会被解析为 `%~1`+`0`。路径不能直接写进 ASCII/OEM 批处理，
// 否则安装目录含中文时会被 cmd.exe 破坏。
//
// 本文件在 require('../client-updater.js') 之前拦截 child_process.spawn；
// node --test 每个文件独立进程，不会影响其他测试文件拿到真实的 spawn。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const recordedSpawns = [];
const realSpawn = cp.spawn;
cp.spawn = function interceptedSpawn(cmd, args, opts) {
  recordedSpawns.push({ cmd, args, opts });
  return { unref() {}, kill() {}, on() {}, once() {}, pid: -1 };
};

const clientUpdater = require('../client-updater.js');

test('applyUpdate passes the bundled node exe through PowerShell as the ninth batch argument', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-arg-'));
  // 生产环境中 updates/ 由下载器创建（Setup 就躺在里面）；applyUpdate 只写文件不建目录
  fs.mkdirSync(path.join(dir, 'updates'), { recursive: true });
  const prevFile = process.env.PORTABLE_EXECUTABLE_FILE;
  // oldExe 取 PORTABLE_EXECUTABLE_FILE，便于断言安装版参数与脚本内容。
  process.env.PORTABLE_EXECUTABLE_FILE = path.join(dir, 'FakeOldApp.exe');
  try {
    const ctx = { userDataDir: dir, log() {} };
    const pending = { path: path.join(dir, 'setup.exe'), version: '4.4.0' };
    const nodeExe = process.execPath;
    clientUpdater.applyUpdate(ctx, pending, {
      userDataDir: dir,
      dshHome: path.join(dir, 'dsh'),
      installDir: path.join(dir, 'inst'),
      profileDir: path.join(dir, 'prof'),
      currentVersion: '4.3.0',
      newVersion: '4.4.0',
      nodeExe,
    });
    assert.ok(recordedSpawns.length >= 1, 'spawn must have been called');
    const last = recordedSpawns[recordedSpawns.length - 1];
    assert.equal(path.basename(last.cmd).toLowerCase(), 'powershell.exe');
    assert.equal(last.args[last.args.indexOf('-WindowStyle') + 1], 'Hidden');
    assert.equal(
      last.args[last.args.indexOf('-ActionScriptPath') + 1],
      path.join(dir, 'updates', 'apply-update.cmd')
    );
    assert.equal(last.args[last.args.indexOf('-NodeExePath') + 1], nodeExe);
    // 写盘脚本只读取第 9 参，不直接嵌入可能含非 ASCII 字符的绝对路径。
    const scriptText = fs.readFileSync(path.join(dir, 'updates', 'apply-update.cmd'), 'utf8');
    assert.ok(scriptText.includes('set "NODEEXE=%~9"'),
      'script must read the bundled node exe from the ninth argument');
    assert.ok(!scriptText.includes(nodeExe), 'script must not embed the Unicode-sensitive absolute path');
    assert.ok(scriptText.includes('"%NODEEXE%" -e'), 'manifest step must use the passed node exe');
    assert.doesNotMatch(scriptText, /%~10/, 'must never reference %~10');
    assert.doesNotMatch(scriptText, /^\s*shift\s*$/m, 'must not rely on shift');
    assert.doesNotMatch(scriptText, /(^|[^"%\w])node\s+-e/, 'script must not invoke bare `node`');
  } finally {
    if (prevFile === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = prevFile;
    cp.spawn = realSpawn;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
