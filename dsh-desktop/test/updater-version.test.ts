import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareVersions } = require('../updater.js');

test('版本号缺少第三段时按 0 补齐', () => {
  assert.equal(compareVersions('4.4', '4.4.0'), 0);
  assert.equal(compareVersions('v4.4', '4.4.0'), 0);
  assert.equal(compareVersions('4.4.1', '4.4'), 1);
  assert.equal(compareVersions('4.3.9', '4.4'), -1);
});

test('预发布版本仍排在正式版本之前', () => {
  assert.equal(compareVersions('4.4.0-rc.1', '4.4.0'), -1);
  assert.equal(compareVersions('4.4.0', '4.4.0-rc.1'), 1);
  assert.equal(compareVersions('4.4.0-rc.2', '4.4.0-rc.1'), 1);
});

test('prerelease 标识符按 semver 规范比较（数字段数值序、字母段字典序、数字<字母）', () => {
  // 旧实现取 pre 里第一个数字当序号：beta.2 会误判 > rc.1
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-rc.1'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  // 数字标识符恒小于字母标识符
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
  // 多段数字按数值比（旧实现整串字典序会把 rc.1.10 判 < rc.1.2）
  assert.equal(compareVersions('1.0.0-rc.1.10', '1.0.0-rc.1.2'), 1);
  // 段数少者为低
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha'), 1);
  // 预发布基础语义不回归
  assert.equal(compareVersions('0.1.2-alpha.1', '0.1.2-alpha.1'), 0);
  assert.equal(compareVersions('0.1.2-alpha.1', '0.1.2'), -1);
});
