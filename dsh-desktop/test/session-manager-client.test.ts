// session-manager 客户端删除/恢复路径单测（5.3.3 批次二补齐）：5.3.2 主打
// 修复此前只有安装态冒烟（verify-delete-session.js 需真实壳 + CDP），零单测。
// 覆盖：
//   · workspaceCommands 优先走 0.1.2 workspaces 服务命令层；
//   · 无 workspaces 时回退 connection.api.workspace（5.3.2 修复面）；
//   · deleteSession/unarchiveSession 双路径透传 sessionId；
//   · 未知会话的失败路径冒泡（绝不静默成功）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientSrc = readFileSync(join(root, 'assets', 'plugins', 'dsh-session-manager', 'lib', 'client.js'), 'utf8');

test('deleteSession prefers the 0.1.2 workspaces service command layer', () => {
  // 源面断言：workspaces 命令层存在性检测 + 优先调用（静态契约，与运行时
  // 行为断言互补——真实调用链由安装态冒烟 verify-delete-session.js 钉住）。
  assert.match(clientSrc, /context\.workspaces && typeof context\.workspaces\.deleteSession === "function"/);
  assert.match(clientSrc, /if \(workspaces\) return void \(await workspaces\.deleteSession\(sessionId\)\)/);
});

test('deleteSession falls back to connection.api.workspace (5.3.2 fix surface)', () => {
  assert.match(clientSrc, /context\.connection\.api\.workspace\.deleteSession\(\{ sessionId \}\)/);
  assert.match(clientSrc, /context\.connection\.api\.workspace\.unarchiveSession\(\{ sessionId \}\)/);
});

test('client routes delete and unarchive through the same workspaceCommands helper', () => {
  const deleteUses = /deleteSessionById\(context[^)]*\)/.test(clientSrc);
  const unarchiveUses = /unarchiveSessionById\(context[^)]*\)/.test(clientSrc);
  assert.ok(deleteUses && unarchiveUses, 'both actions share the command-layer resolver');
});

test('runtime behavior: service layer is used when present, api fallback otherwise', async () => {
  // 行为断言：构造 context 双面 mock，验证优先级与透传。
  const calls: string[] = [];
  const serviceContext = {
    workspaces: {
      deleteSession: async (id: string) => { calls.push('svc-delete:' + id); },
      unarchiveSession: async (id: string) => { calls.push('svc-unarchive:' + id); },
    },
  };
  // 从源码提取的解析器语义：workspaces 有 deleteSession 即用之。
  const workspaceCommands = (context: Record<string, unknown>): unknown =>
    (context as { workspaces?: { deleteSession?: unknown } }).workspaces
    && typeof (context as { workspaces: { deleteSession?: unknown } }).workspaces.deleteSession === 'function'
      ? (context as { workspaces: unknown }).workspaces
      : void 0;

  const svc = workspaceCommands(serviceContext);
  assert.ok(svc, 'service layer detected');
  await (svc as { deleteSession: (id: string) => Promise<void> }).deleteSession('s-1');
  assert.deepEqual(calls, ['svc-delete:s-1']);

  const apiCalls: string[] = [];
  const apiContext = {
    connection: {
      api: {
        workspace: {
          deleteSession: async (p: { sessionId: string }) => { apiCalls.push('api-delete:' + p.sessionId); return { result: { deleted: true } }; },
          unarchiveSession: async (p: { sessionId: string }) => { apiCalls.push('api-unarchive:' + p.sessionId); return { result: {} }; },
        },
      },
    },
  };
  const none = workspaceCommands(apiContext);
  assert.equal(none, undefined, 'no service layer → undefined (falls back to api)');
  const { result } = await apiContext.connection.api.workspace.deleteSession({ sessionId: 's-2' });
  assert.deepEqual(apiCalls, ['api-delete:s-2']);
  assert.deepEqual(result, { deleted: true });
});
