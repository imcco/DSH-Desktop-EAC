import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 项目约定：测试 import 编译产物 .js（tsc 就地产物）。
const { cleanupClientBackupIfHealthy } = require('../client-updater.js') as {
  // ⚠️ 异步语义（fs.promises.rm，严禁在 boot 关键路径同步删大目录）：
  cleanupClientBackupIfHealthy(ctx: unknown, opts?: unknown): Promise<{ removed: string[]; kept: string[] }>;
}

// ---------------------------------------------------------------------------
// V4.3/V4.1 保障③承诺的 cleanupClientBackupIfHealthy 回归：安装版自更新每次
// 留 <userData>/backups/<ts>/ 全量镜像 + .backup-ts marker，「新版健康启动后
// 清理」在 Tauri 化后一直没有实现 —— 更新频繁的用户磁盘被逐次吃满。
// 语义：>24h 静默删；未满 24h 保留（marker 同时保留）；全部清完才删 marker。
// ---------------------------------------------------------------------------

function makeCtx(dir: string) {
  return { userDataDir: dir, log: (_s: string, _m: string) => {} };
}

test('cleanup：超 24h 的备份删除，未满 24h 的保留且 marker 不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bak-clean-'))
  try {
    const oldTs = String(Date.now() - 25 * 60 * 60 * 1000)
    const newTs = String(Date.now())
    mkdirSync(join(dir, 'backups', oldTs), { recursive: true })
    mkdirSync(join(dir, 'backups', newTs), { recursive: true })
    writeFileSync(join(dir, 'backups', oldTs, 'manifest.json'), '{}')
    mkdirSync(join(dir, 'updates'), { recursive: true })
    writeFileSync(join(dir, 'updates', '.backup-ts'), oldTs)
    const r = await cleanupClientBackupIfHealthy(makeCtx(dir))
    assert.deepEqual(r.removed, [oldTs])
    assert.deepEqual(r.kept, [newTs])
    assert.ok(existsSync(join(dir, 'backups', newTs)), '未满 24h 的备份必须保留')
    assert.ok(existsSync(join(dir, 'updates', '.backup-ts')), '还有保留备份时 marker 不删')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup：全部清完时删除 .backup-ts marker；.keep 标记的备份不删', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bak-clean2-'))
  try {
    const oldTs = String(Date.now() - 30 * 60 * 60 * 1000)
    const keepTs = String(Date.now() - 48 * 60 * 60 * 1000)
    mkdirSync(join(dir, 'backups', oldTs), { recursive: true })
    mkdirSync(join(dir, 'backups', keepTs), { recursive: true })
    writeFileSync(join(dir, 'backups', keepTs, '.keep'), '')
    mkdirSync(join(dir, 'updates'), { recursive: true })
    writeFileSync(join(dir, 'updates', '.backup-ts'), oldTs)
    const r = await cleanupClientBackupIfHealthy(makeCtx(dir))
    assert.deepEqual(r.removed, [oldTs])
    assert.ok(existsSync(join(dir, 'backups', keepTs)), '.keep 备份不删')
    // 仍有保留中的备份（.keep）时 marker 不动 —— marker 只在「清完所有备份」
    // 的时机一并回收。
    assert.ok(existsSync(join(dir, 'updates', '.backup-ts')), '仍有保留备份时 marker 不删')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup：无 backups 目录时安全空跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bak-clean3-'))
  try {
    const r = await cleanupClientBackupIfHealthy(makeCtx(dir))
    assert.deepEqual(r.removed, [])
    assert.deepEqual(r.kept, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup：真实时间戳格式归一化 —— Unix 秒（10位）备份 24h 窗口生效', async () => {
  // apply 脚本主路径（PowerShell ToUnixTimeSeconds）产出 10 位秒级目录名。
  // 旧实现直接 parseInt 与 Date.now()(毫秒) 混比：秒级值永远「超 24h」被
  // 立即删 —— 24h 回滚保护窗形同虚设（本用例钉住修复）。
  const dir = mkdtempSync(join(tmpdir(), 'bak-clean4-'))
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const freshSec = String(nowSec - 3600)          // 1 小时前（秒）→ 必须保留
    const oldSec = String(nowSec - 26 * 3600)       // 26 小时前（秒）→ 应删除
    mkdirSync(join(dir, 'backups', freshSec), { recursive: true })
    mkdirSync(join(dir, 'backups', oldSec), { recursive: true })
    const r = await cleanupClientBackupIfHealthy(makeCtx(dir))
    assert.deepEqual(r.removed, [oldSec], '秒级 26h 前的备份应删')
    assert.deepEqual(r.kept, [freshSec], '秒级 1h 前的备份必须保留在 24h 保护窗内')
    assert.ok(existsSync(join(dir, 'backups', freshSec)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup：YYYYMMDDHHmmss（14位 batch 兜底格式）正确解析本地时区时间', async () => {
  // PowerShell 缺席时 batch 用 %date%/%time% 拼 14 位本地时间。旧实现 parseInt
  // 得 2e13 > now-ms → Date.now()-at 为负 → 永远不删（磁盘泄漏）。
  const dir = mkdtempSync(join(tmpdir(), 'bak-clean5-'))
  try {
    const fmt = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
      `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
    const fresh14 = fmt(new Date(Date.now() - 3600_000))       // 1h 前 → 保留
    const old14 = fmt(new Date(Date.now() - 26 * 3600_000))    // 26h 前 → 删
    mkdirSync(join(dir, 'backups', fresh14), { recursive: true })
    mkdirSync(join(dir, 'backups', old14), { recursive: true })
    const r = await cleanupClientBackupIfHealthy(makeCtx(dir))
    assert.deepEqual(r.removed, [old14], '14 位 26h 前的备份应删（修复前永远不删）')
    assert.deepEqual(r.kept, [fresh14], '14 位 1h 前的备份应保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
