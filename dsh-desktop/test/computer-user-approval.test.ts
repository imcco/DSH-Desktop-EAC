import test from 'node:test'
import assert from 'node:assert/strict'
import { createComputerTools } from '../assets/plugins/computer-user/src/tools.js'

// ---------------------------------------------------------------------------
// computer-user 手动批准流单测（manual 模式 /computer 批准语义）：
//   1) manual 模式未批准会话 → awaitingApproval（提示发送 /computer 批准）
//   2) /computer 已批准会话 → 直接放行执行
//   3) 批准是会话级别的：其他会话已批准不影响本会话
//   4) 只读工具在 manual 模式不要求批准
//   5) disabled / readonly 模式拒绝副作用工具（readonly 下截图类放行）
//
// 兼容说明：历史调用方仍可传单个 sessionId；Host 接线传 sessionIds 候选，
// 覆盖 agent.id、session.header.sessionId 与 exec.sessionId。候选中任一身份命中
// approvedSessions 即视为已批准。测试不再依赖 5.1.1 的 requestApproval 问答，
// manual 模式统一由 /computer 命令批准。
// ---------------------------------------------------------------------------

function makeTools({ mode = 'manual', approvedSessions, sessionId, sessionIds } = {}) {
  const calls = []
  const runPs = async (script, payload) => {
    calls.push({ script, payload })
    return { ok: true, cursor: [1, 2] }
  }
  const getConfig = () => ({ mode, screenshot_dir: '', default_scale: 1, typing_interval_ms: 0, scroll_units: 120, debug: false })
  const tools = createComputerTools({ runPs, getConfig, approvedSessions, sessionId, sessionIds, setMode: async () => {} })
  const byName = (name) => tools.find((t) => t.name === name)
  return { calls, byName, runPs }
}

function execFor(sid) {
  return {
    callId: 'call-1',
    arguments: { coordinate: [10, 20] },
    agent: { session: { header: { sessionId: sid } } },
    signal: new AbortController().signal,
  }
}

test('manual + 未批准会话 → 抛 awaitingApproval 且不执行', async () => {
  const t = makeTools({ approvedSessions: new Set() })
  await assert.rejects(
    () => t.byName('computer_click').execute({ coordinate: [10, 20] }, execFor('s1')),
    (err) => err.awaitingApproval === true && /\/computer/.test(err.message),
  )
  assert.equal(t.calls.length, 0)
})

test('manual + 已批准会话 → 直接放行执行', async () => {
  const t = makeTools({ approvedSessions: new Set(['s1']), sessionId: 's1' })
  const res = await t.byName('computer_click').execute({ coordinate: [10, 20] }, execFor('s1'))
  assert.equal(res.clicked !== undefined, true)
  assert.ok(t.calls.some((c) => c.script === 'input.ps1'))
})

test('manual + agent.id 已批准但会话头不同 → 候选身份任一命中即放行', async () => {
  const t = makeTools({
    approvedSessions: new Set(['agent-1']),
    sessionIds: ['agent-1', 'session-header-1'],
  })
  const res = await t.byName('computer_click').execute(
    { coordinate: [10, 20] },
    execFor('session-header-1'),
  )
  assert.equal(res.clicked !== undefined, true)
  assert.ok(t.calls.some((c) => c.script === 'input.ps1'))
})

test('manual + 其他会话已批准 → 本会话仍要求批准', async () => {
  const t = makeTools({ approvedSessions: new Set(['s-other']), sessionId: 's1' })
  await assert.rejects(
    () => t.byName('computer_click').execute({ coordinate: [10, 20] }, execFor('s1')),
    (err) => err.awaitingApproval === true,
  )
  assert.equal(t.calls.length, 0)
})

test('readonly 工具在 manual 模式不要求批准', async () => {
  const t = makeTools({ approvedSessions: new Set() })
  const res = await t.byName('computer_wait').execute({ ms: 1 }, execFor('s1'))
  assert.equal(res.waited, 1)
})

test('disabled 与 readonly 模式拒绝副作用工具', async () => {
  const disabled = makeTools({ mode: 'disabled' })
  await assert.rejects(() => disabled.byName('computer_click').execute({}, execFor('s1')), /已禁用/)
  const readonly = makeTools({ mode: 'readonly' })
  await assert.rejects(() => readonly.byName('computer_click').execute({}, execFor('s1')), /只读模式/)
  // 但截图类只读工具在 readonly 下放行
  await readonly.byName('computer_screenshot').execute({}, execFor('s1'))
  assert.ok(readonly.calls.some((c) => c.script === 'capture.ps1'))
})

test('host 设置写入使用 SettingsScope.update，不调用不存在的 set', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(
    new URL('../assets/plugins/computer-user/src/index.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /scope\.update\(\{\s*\[key\]: value\s*\}\)/)
  assert.doesNotMatch(source, /scope\.set\(/)
})

test('host 工具接线把 agent.id 与会话头都传入批准候选', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(
    new URL('../assets/plugins/computer-user/src/index.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /exec\?\.agent\?\.id/)
  assert.match(source, /exec\?\.agent\?\.session\?\.header\?\.sessionId/)
  assert.match(source, /createComputerTools\(\{[^}]*sessionIds[^}]*\}\)/)
})
