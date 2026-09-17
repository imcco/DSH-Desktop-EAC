// 诊断 zip 平台化命令：darwin 用内置 ditto；其他平台不经过 shell。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZipCommand } from '../../tauri-shell/sidecar/rescue-integration.js';

test('darwin 诊断 zip 使用 ditto 归档 logs 目录', () => {
  const cmd = buildZipCommand('darwin', '/tmp/logs', '/tmp/out.zip');
  assert.equal(cmd.program, 'ditto');
  assert.deepEqual(cmd.args, ['-c', '-k', '/tmp/logs', '/tmp/out.zip']);
});

test('win32 诊断 zip 不再拼接 PowerShell 命令', () => {
  const cmd = buildZipCommand('win32', 'C:\\logs', 'C:\\out.zip');
  assert.equal(cmd, null);
});
