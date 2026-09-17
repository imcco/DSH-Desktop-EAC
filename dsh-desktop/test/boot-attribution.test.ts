import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// 防呆（v4.2，用户反馈问题 4）：插件装完 web 起不来时，错误弹窗只能
// 「回退到上一版本/内置版本」，对用户来说等于白装。本测试覆盖：
//   · attributeBootFailure —— 把报错文案里的包名/行 id 归因到 profile 里
//     可停用的插件（patch 行 id/name、bundle、dependency），归因失败返回 null。
//   （guardedBoot 完整重试链已随 5.3.3 精简删除：Tauri 化断线后无运行时
//    调用方，sidecar 启动链自带等价有界重试；markGood/reportIncident 由
//    sidecar guardedStartAndWait 最小接线。）

const require = createRequire(import.meta.url);
const { createGuard } = require('../plugin-guard.js');

function makeHome(root) {
  const home = join(root, 'dsh-home');
  const profile = join(home, 'profiles', 'web-desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web-desktop',
    dependencies: { 'meow-memory': 'github:zhang-meow/meow-memory' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'api-gateway'] } },
  }, null, 2) + '\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: dsh-tool-vision',
    "  name: 'dsh-tool-vision'",
    "  config:",
    "    vision: true",
    '- insert:',
    '    - id: mkt-1',
    "      name: 'dsh-pet'",
    '',
  ].join('\n'));
  return { home, profile, guard: createGuard({ getHome: () => home, getProfile: () => 'web-desktop', dshBin: () => '', log: () => {} }) };
}

test('attributeBootFailure：命中 patch 行 id（duplicate loader entry）', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    const hit = guard.attributeBootFailure("duplicate loader entry 'dsh-tool-vision'");
    assert.deepEqual(hit, { name: 'dsh-tool-vision', kind: 'patchRow', rowId: 'dsh-tool-vision' });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('attributeBootFailure：命中 insert 内层行的 name（Cannot find module）', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    const hit = guard.attributeBootFailure('Cannot find module "dsh-pet"');
    assert.deepEqual(hit, { name: 'dsh-pet', kind: 'patchRow', rowId: 'mkt-1' });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('attributeBootFailure：命中 bundle（duplicate entry）', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    const hit = guard.attributeBootFailure('duplicate entry: api-gateway');
    assert.deepEqual(hit, { name: 'api-gateway', kind: 'bundle', rowId: null });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('attributeBootFailure：命中 dependencies 键', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    const hit = guard.attributeBootFailure('Failed to load plugin "meow-memory": exit code 1');
    assert.deepEqual(hit, { name: 'meow-memory', kind: 'dependency', rowId: null });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('attributeBootFailure：无关文案返回 null', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    assert.equal(guard.attributeBootFailure('ERR_OSSL_EVP_UNSUPPORTED: legacy provider'), null);
    assert.equal(guard.attributeBootFailure(''), null);
    assert.equal(guard.attributeBootFailure(null), null);
  } finally { rmSync(t, { recursive: true, force: true }); }
});
