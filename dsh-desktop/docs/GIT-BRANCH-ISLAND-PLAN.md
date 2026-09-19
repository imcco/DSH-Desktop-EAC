# git 灵动岛(dsh-git-branch)规划

> 状态:实施中 · 目标版本 0.1.0(未发布,直接演进)· 领域:L3 DSH 插件(纯客户端)

## 1. 背景

`dsh-git-branch` 是 EAC 原研插件,当前形态是输入区左侧插槽的一个「分支 chip + 单一下拉」:
显示当前分支 + 脏区圆点,点击列出本地分支,二次确认切换。

痛点:

- 只能看/切分支,看不到**改了什么**(文件、暂存区、未跟踪)。
- 没有**提交**入口,工作流断在「必须切到终端 / 侧边栏」。
- 没有**历史**入口,无法快速回看最近提交。

目标:把它升级为输入区的 **git 灵动岛** —— 一个紧凑 pill(收起态)+ 可展开的四合一面板,
覆盖「看状态 → 看改动 → 切分支 → 提交 → 回看历史」的本地 git 闭环。

## 2. 范围

### 本期(In)

| 能力 | 说明 |
| --- | --- |
| 收起态 pill | 分支名 + 改动数徽标(暂存绿/未暂存橙/未跟踪青 分色统计),可被输入灵动岛收编 |
| 改动 tab | 文件清单(状态字符 + 路径)、关键词过滤、单文件 diff 查看、单文件暂存/取消暂存/丢弃(确认)、全部暂存/取消全部暂存 |
| 分支 tab | 搜索 + 分支列表 + 二次确认切换(沿用现有行为) |
| 提交 tab | 提交信息输入 → 全部暂存 + 提交(二次确认);最近 10 条提交列表(hash/标题/作者/时间/refs),点选查看 commit diff |
| 可测性 | 纯逻辑核心挂 `window.__dshGitBranchCore`,node vm 测试;插件契约测试(包名/exports/patch 行/插槽/模块 id) |

### 本期不做(Out)

- **新建分支**:`/sidebar/api` 无 `git.branch-create` 端点,不承诺无法交付的按钮;后续可加端点后补。
- **ahead/behind、远程操作**(fetch/push/pull):无端点,且涉及凭据与网络,超出本期。
- **独立浮窗 / 全局悬浮岛**:复用 `conversation.input.left` 插槽,形态上与输入灵动岛一致(被收编后随岛展开),不引入新窗口。
- **提交拆分 / 交互式 rebase**:高风险,交给侧边栏源码面板。

## 3. 架构约束(红线)

1. **零宿主新代码**:全部 git 能力复用 `dsh-better-sidebar` 既有 `/sidebar/api` 端点与
   `dsh-file-changes` 的 `session-cwd`;host 半边保持 no-op。
2. **插槽契约不变**:`conversation.input.left` / 插件 id `dsh-git-branch` / order 50,
   根节点保持 `<button>` → 输入灵动岛(`dsh-composer-dynamic-island`)的收编逻辑不受影响。
3. **破坏性操作必须显式确认**:checkout、commit、discard 全部走确认条;不自动 stash、不碰未确认数据。
4. **错误透传**:git 原始报错原样展示(不吞、不改写),脏工作区 checkout 失败即失败。
5. **非 git 工作区 / 无会话目录 → 自动隐藏**,不渲染空 chip。
6. 不新增 RPC、不改 bridge、不动 L1/L2 → 验证级别不需要 V3/V4(按影响矩阵为 L3 插件改动)。

## 4. 端点映射

| 能力 | 端点 | 载荷 | 响应 |
| --- | --- | --- | --- |
| 状态 | `git.status` | `{cwd}` | `{isRepo, branch, entries:[{path, xy}]}` |
| 分支列表 | `git.branch` | `{cwd}` | `{current, names[]}` |
| 切换分支 | `git.checkout` | `{cwd, branch}` | `{ok}` |
| 工作区/暂存 diff | `git.diff` | `{cwd, path?, staged?}` | `{diff}` |
| 暂存 | `git.stage` | `{cwd, path?}` | `{ok}` |
| 取消暂存 | `git.unstage` | `{cwd, path?}` | `{ok}` |
| 提交 | `git.commit` | `{cwd, message}` | `{ok}` |
| 丢弃改动 | `git.discard` | `{cwd, path}` | `{ok}` |
| 提交历史 | `git.log` | `{cwd, count}` | `[{hash, subject, author, date, hashFull, refs}]` |
| 提交 diff | `git.commit-diff` | `{cwd, hash}` | `{diff}` |
| 新文件内容 | `fs.read` | `{cwd, path}` | `{kind:'text', content}` / `{kind:'binary'}` |
| 会话目录 | `/api/dsh-files/session-cwd?sessionId=` | — | `{cwd}` |

`xy`(porcelain v1 双字符)语义:`xy[0]` 暂存区、`xy[1]` 工作区、`??` 未跟踪。
分色统计:staged = `xy[0] ∉ {' ', '?'}`,unstaged = `xy[1] ≠ ' '`,untracked = `xy[0] === '?'`。

diff 来源优先级:有工作区改动 → worktree diff;仅暂存 → staged diff;未跟踪 → worktree diff
恒为空,回退 `fs.read` 展示新文件内容(二进制显示占位)。

## 5. UI 规格

### 收起态

`⎇ main  ③`(徽标 = 总改动数,>9 显示 `9+`;按 staged/unstaged/untracked 占比着色:
有暂存 → 绿,否则有未暂存 → 橙,仅未跟踪 → 青)。非脏时不显示徽标。

### 展开态(灵动岛面板,fixed 定位于 chip 上方,视口内 clamp)

```
┌──────────────────────────────────────────┐
│ ⎇ main · 3 处改动            [刷新] [✕] │
│ [改动 3]  [分支]  [提交]                  │
├──────────────────────────────────────────┤
│ 暂存 1 · 未暂存 1 · 未跟踪 1   [全部暂存] │
│ [过滤文件…                                ]│
│  M src/lib/a.ts        [diff][暂存][丢弃] │
│  M src/lib/b.ts        [diff][暂存]      │
│  ?? new/file.md        [diff][暂存]      │
└──────────────────────────────────────────┘
```

- **diff 抽屉**:替换列表区,顶部 `[←] path` + `+N -M`,等宽 pre;`+` 绿 / `-` 红 / `@@` 蓝。
  提交 tab 点历史项进入同一抽屉(数据源 `git.commit-diff`)。
- **分支 tab**:搜索框 + 列表(当前分支 ✓ 高亮),选中非当前分支出现确认条
  「切换到 X?会改动工作区文件 [取消][切换]」。
- **提交 tab**:多行输入 + `[全部暂存并提交]`(信息为空禁用);确认条后执行
  `git.stage(all) → git.commit(message)`;下方「最近提交」列表。
- **错误区**:面板底部 `pre`,展示 git 原始报错。
- 交互:点击外部 / Esc 关闭;每次展开刷新分支列表与状态;轮询 15s + 窗口聚焦刷新;
  每次变更操作后即时刷新状态(当前 tab 数据同步刷新)。

## 6. 可测性与验证

- 纯逻辑核心(`window.__dshGitBranchCore`):`unwrapEnvelope / xyKinds / statusToIsland /
  statusEntries / diffKindFor / filterEntries / branchesToList / logToRows / displayBranch /
  truncateDateLabel / diffStats` —— node `vm` 载入真实 bundle 评估(先例:`dsh-file-drop-eac-core.test.ts`)。
- 新增 `test/git-branch-island.test.ts`:纯核心行为 + 包契约(package.json exports、
  cordis.patch.yml 行、dsh-plugin.json、模块 id、插槽名与 order、host no-op)。
- 验证级别(影响矩阵:L3 插件文件 + 注册表测试已就位):
  - **V1 定向**:`git-branch-island` + `composer-dynamic-island-integration` +
    `companion-plugins-registry` + `plugin-sync` + `typecheck`。
  - **V2 全量**:`dsh-desktop` `npm test`(pretest 自动 tsc build)。
  - `npm run plugin:sync` 重新生成 `.sync/plugins.lock.json` 摘要。
  - V4 运行时(手动):真实 git 仓库中验证展开/切换/提交/丢弃;不在自动化范围内,结果按 partial 计。

## 7. 里程碑

| # | 内容 | 产物 |
| --- | --- | --- |
| M1 | 规划文档 | 本文件 |
| M2 | 纯逻辑核心 + vm 测试 | `lib/client.js` core、`test/git-branch-island.test.ts` |
| M3 | 改动 tab(状态/过滤/diff/暂存/丢弃) | client.js UI |
| M4 | 分支 tab + 提交 tab(历史/commit diff) | client.js UI |
| M5 | 验证与文档 | V1+V2、lock 重生成、README 更新 |
| M6 | 汇报(改动/验证/未验证项/残余风险) | 会话报告 |

## 8. 风险与残余

| 风险 | 缓解 |
| --- | --- |
| 面板与输入灵动岛收编后的 fixed 定位互相遮挡 | 两者 z-index 体系不同(2147482999 vs 40/41);收编后 chip 随岛项定位,面板 clamp 进视口 |
| 大仓库 `git status --untracked-files=all` 偏慢 | 15s 轮询 + 仅聚焦/操作时刷新;端点侧已有 30s 超时 |
| 未跟踪文件 diff 为空 | 回退 `fs.read` 内容展示,二进制给占位提示 |
| 无新建分支端点 | UI 不出现该入口,README 明确「本期不做」 |
