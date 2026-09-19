// Tests for the dsh-git-branch companion plugin（git 灵动岛）.
// 纯逻辑挂在 lib/client.js 的 `window.__dshGitBranchCore`（classic-script
// bundle，官方加载器不允许 import），故用 vm 载入真实 bundle 评估；
// 另覆盖包契约（exports / cordis patch 行 / 模块 id / 插槽注册）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'assets', 'plugins', 'dsh-git-branch');

function text(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

function json(...parts: string[]): Record<string, any> {
  return JSON.parse(text(...parts));
}

/** 用 stubbed window 载入真实 client bundle，返回暴露的 core 与 handoff。 */
function loadBundle() {
  const src = text(PLUGIN, 'lib', 'client.js');
  const captured: { handoff?: { id: string; factory: (require: (m: string) => unknown) => unknown } } = {};
  const win: Record<string, unknown> = {
    __ModuleLoader__: { load: (handoff: unknown) => { captured.handoff = handoff as typeof captured.handoff; } },
  };
  const document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vm.runInNewContext(src, { window: win, document, console });
  assert.ok(captured.handoff, 'bundle must register via __ModuleLoader__.load');
  assert.equal(captured.handoff.id, '@deepseek-ai/dsh-git-branch', 'handoff must carry the scoped package id');
  assert.ok(win.__dshGitBranchCore, 'bundle must expose the pure core');
  return { core: win.__dshGitBranchCore as Record<string, (...args: never[]) => unknown>, handoff: captured.handoff! };
}

const { core } = loadBundle();

/** vm 产物跨 realm（prototype 不同），JSON roundtrip 回宿主 realm 再深比较。 */
function hostify<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ───────────────────────── 纯核心：envelope ─────────────────────────

test('unwrapEnvelope: ok envelope returns value', () => {
  assert.deepEqual(hostify(core.unwrapEnvelope({ ok: true, value: [1, 2] })), [1, 2]);
  assert.equal(core.unwrapEnvelope({ ok: true, value: 42 }), 42);
});

test('unwrapEnvelope: !ok throws with the git-level message', () => {
  assert.throws(() => core.unwrapEnvelope({ ok: false, error: { message: 'fatal: not a git repository' } }), /not a git repository/);
  assert.throws(() => core.unwrapEnvelope({ ok: false, error: { code: 'git-error' } }), /git-error/);
});

test('unwrapEnvelope: non-object responses throw a readable error', () => {
  assert.throws(() => core.unwrapEnvelope(null), /接口无响应/);
  assert.throws(() => core.unwrapEnvelope('x'), /接口无响应/);
});

// ───────────────────────── 纯核心：xy 语义 ─────────────────────────

test('xyKinds: porcelain v1 双字符三维度', () => {
  assert.deepEqual(hostify(core.xyKinds('M ')), { staged: true, unstaged: false, untracked: false });
  assert.deepEqual(hostify(core.xyKinds(' M')), { staged: false, unstaged: true, untracked: false });
  assert.deepEqual(hostify(core.xyKinds('MM')), { staged: true, unstaged: true, untracked: false });
  assert.deepEqual(hostify(core.xyKinds('A ')), { staged: true, unstaged: false, untracked: false });
  assert.deepEqual(hostify(core.xyKinds('R ')), { staged: true, unstaged: false, untracked: false });
  assert.deepEqual(hostify(core.xyKinds('D ')), { staged: true, unstaged: false, untracked: false });
  assert.deepEqual(hostify(core.xyKinds('??')), { staged: false, unstaged: false, untracked: true });
  assert.deepEqual(hostify(core.xyKinds('')), { staged: false, unstaged: false, untracked: false });
  assert.deepEqual(hostify(core.xyKinds(undefined)), { staged: false, unstaged: false, untracked: false });
});

test('xyGlyph: 未跟踪 → U，否则工作区字符优先', () => {
  assert.equal(core.xyGlyph('??'), 'U');
  assert.equal(core.xyGlyph(' M'), 'M');
  assert.equal(core.xyGlyph('M '), 'M');
  assert.equal(core.xyGlyph('MM'), 'M');
  assert.equal(core.xyGlyph('A '), 'A');
});

// ───────────────────────── 纯核心：状态归约 ─────────────────────────

test('statusToIsland: 分维度计数（暂存/未暂存/未跟踪）', () => {
  const island = core.statusToIsland({
    isRepo: true,
    branch: 'main',
    entries: [
      { path: 'a.ts', xy: 'M ' },
      { path: 'b.ts', xy: ' M' },
      { path: 'c.md', xy: '??' },
      { path: 'd.ts', xy: 'MM' },
      { path: 'e.ts', xy: 'A ' },
    ],
  }) as { branch: string; total: number; staged: number; unstaged: number; untracked: number; dirty: boolean };
  assert.equal(island.branch, 'main');
  assert.equal(island.total, 5);
  assert.equal(island.staged, 3, 'a(M ) + d(MM) + e(A )');
  assert.equal(island.unstaged, 2, 'b( M) + d(MM)');
  assert.equal(island.untracked, 1, 'c(??)');
  assert.equal(island.dirty, true);
});

test('statusToIsland: 非仓库/缺省 → null 或干净态', () => {
  assert.equal(core.statusToIsland(null), null);
  assert.equal(core.statusToIsland({ isRepo: false, entries: [] }), null);
  const clean = core.statusToIsland({ isRepo: true }) as { branch: string; total: number; dirty: boolean };
  assert.equal(clean.branch, 'HEAD');
  assert.equal(clean.total, 0);
  assert.equal(clean.dirty, false);
});

test('statusEntries: 过滤无 path 的坏行', () => {
  const entries = core.statusEntries({
    entries: [{ path: 'ok.ts', xy: ' M' }, { xy: 'M ' }, { path: '', xy: ' M' }, null],
  }) as Array<{ path: string; xy: string }>;
  assert.deepEqual(hostify(entries), [{ path: 'ok.ts', xy: ' M' }]);
});

// ───────────────────────── 纯核心：diff 来源与过滤 ─────────────────────────

test('diffKindFor: 工作区改动优先，仅暂存走 staged', () => {
  assert.equal(core.diffKindFor(' M'), 'worktree');
  assert.equal(core.diffKindFor('MM'), 'worktree');
  assert.equal(core.diffKindFor('M '), 'staged');
  assert.equal(core.diffKindFor('A '), 'staged');
  assert.equal(core.diffKindFor('??'), 'worktree', '未跟踪走 worktree（恒空 → 客户端回退 fs.read）');
});

test('filterEntries: 大小写不敏感子串；空查询返回全部', () => {
  const entries = [{ path: 'src/A.ts', xy: ' M' }, { path: 'lib/B.ts', xy: ' M' }];
  assert.deepEqual(hostify(core.filterEntries(entries, 'src')), [{ path: 'src/A.ts', xy: ' M' }]);
  assert.deepEqual(hostify(core.filterEntries(entries, 'LIB')), [{ path: 'lib/B.ts', xy: ' M' }]);
  assert.equal(core.filterEntries(entries, '').length, 2);
  assert.deepEqual(hostify(core.filterEntries(null, 'x')), []);
});

test('branchesToList / filterBranches: 当前分支始终可见', () => {
  assert.deepEqual(hostify(core.branchesToList({ names: ['a', 'b'] })), ['a', 'b']);
  assert.deepEqual(hostify(core.branchesToList(null)), []);
  assert.deepEqual(hostify(core.filterBranches(['main', 'feat/a'], 'feat', 'main')), ['main', 'feat/a'], '当前分支不匹配也置顶保留');
  assert.deepEqual(hostify(core.filterBranches(['main', 'feat/a'], 'main', 'main')), ['main']);
  assert.deepEqual(hostify(core.filterBranches(['main'], '', 'main')), ['main']);
});

// ───────────────────────── 纯核心：历史与 diff 统计 ─────────────────────────

test('logToRows + truncateDateLabel: 展示行与本地友好时间', () => {
  const rows = core.logToRows([
    { hash: 'abc1234', subject: 'fix: thing', author: 'dev', date: '2026-09-12T23:06:00+08:00', hashFull: 'abc1234def', refs: 'HEAD -> main' },
  ]) as Array<Record<string, string>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, 'abc1234');
  assert.equal(rows[0].dateLabel, '2026-09-12 23:06');
  assert.equal(rows[0].refs, 'HEAD -> main');
  assert.equal(core.truncateDateLabel('2026-09-12 23:06:00'), '2026-09-12 23:06');
  assert.equal(core.truncateDateLabel('garbage'), '');
  assert.deepEqual(hostify(core.logToRows(null)), []);
});

test('diffStats: 统计增删行（排除文件头 +++/---）', () => {
  const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n+new2\n';
  const stats = core.diffStats(diff) as { added: number; removed: number };
  assert.equal(stats.added, 2);
  assert.equal(stats.removed, 1);
  assert.deepEqual(hostify(core.diffStats('')), { added: 0, removed: 0 });
});

test('displayBranch: 超长截断且带省略号', () => {
  assert.equal(core.displayBranch('main'), 'main');
  const long = 'a-very-long-branch-name-that-exceeds-limit';
  const out = core.displayBranch(long) as string;
  assert.equal(out.length, 24);
  assert.ok(out.endsWith('…'));
});

// ───────────────────────── 契约：包 / patch / 插槽 ─────────────────────────

test('package.json 保持 EAC Web loader 契约', () => {
  const pkg = json(PLUGIN, 'package.json');
  assert.equal(pkg.name, '@deepseek-ai/dsh-git-branch');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.dsh.client.inject.includes('react'));
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'));
});

test('cordis patch 行与 dsh-plugin.json 一致', () => {
  const patch = text(PLUGIN, 'cordis.patch.yml');
  assert.match(patch, /id: git-branch/);
  assert.match(patch, /name: '@deepseek-ai\/dsh-git-branch'/);
  const manifest = json(PLUGIN, 'dsh-plugin.json');
  assert.equal(manifest.id, 'io.github.deepseek-harness.dsh-git-branch');
  assert.equal(manifest.facets.host.entry, 'lib/index.js');
});

test('client bundle 注册契约：模块 id / 插槽 / order / 纯核心', () => {
  const client = text(PLUGIN, 'lib', 'client.js');
  assert.match(client, /id: '@deepseek-ai\/dsh-git-branch'/);
  assert.match(client, /name: 'conversation\.input\.left'/);
  assert.match(client, /id: 'dsh-git-branch'/);
  assert.match(client, /order: 50/);
  assert.match(client, /window\.__dshGitBranchCore/);
  assert.doesNotThrow(() => new Function(client), 'classic-script bundle 必须可被 new Function 评估');
});

test('host 半边保持 no-op（零宿主新代码约束）', () => {
  const host = text(PLUGIN, 'lib', 'index.js');
  assert.match(host, /export const name = 'git-branch'/);
  assert.match(host, /export const inject = \[\]/);
  assert.match(host, /export function apply\(\)/);
});

test('companion 注册表包含 git-branch 行', () => {
  const registry = text(ROOT, 'lib', 'desktop', 'companion-sync.ts');
  assert.match(registry, /\{ id: 'git-branch', name: '@deepseek-ai\/dsh-git-branch', dir: 'dsh-git-branch' \}/);
});

// ───────────────────────── 工厂与插槽注册（stub react） ─────────────────────────

test('factory 输出 slots 插件，注册 conversation.input.left / dsh-git-branch / order 50', () => {
  const { handoff } = loadBundle();
  const reactStub = {
    createElement: () => null,
    useRef: (v: unknown) => ({ current: v }),
    useState: (v: unknown) => [v, () => {}],
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
    useReducer: (fn: (...a: never[]) => number, init: number) => [init, () => {}],
    Fragment: 'Fragment',
  };
  let captured: ((props: { sessionId: string }) => unknown) | null = null;
  let descriptor: Record<string, unknown> | null = null;
  const plugin = handoff.factory((name) => {
    if (name === 'react') return reactStub;
    assert.fail(`unexpected module: ${name}`);
  }) as { name: string; inject: string[]; apply: (ctx: unknown) => void };

  assert.equal(plugin.name, 'dsh-git-branch-client');
  assert.deepEqual([...plugin.inject], ['slots'], 'vm realm 数组经展开回宿主再比较');
  plugin.apply({
    inject: (scopes: string[], fn: (scope: unknown) => void) => {
      assert.deepEqual([...scopes], ['slots']);
      fn({
        slots: {
          inject: (slotName: string, reg: () => void) => {
            assert.equal(slotName, 'conversation.input.left');
            reg();
          },
          register: (d: Record<string, unknown>, component: unknown) => {
            descriptor = d;
            captured = component as (props: { sessionId: string }) => unknown;
            return () => {};
          },
        },
      });
    },
  });
  assert.ok(descriptor, 'slot descriptor registered');
  assert.equal(descriptor!.id, 'dsh-git-branch');
  assert.equal(descriptor!.order, 50);
  assert.equal(typeof captured, 'function');
});
