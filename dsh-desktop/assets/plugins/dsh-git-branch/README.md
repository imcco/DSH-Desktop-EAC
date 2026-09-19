# dsh-git-branch

输入区（可被「输入灵动岛」收编）的 **git 灵动岛**：一个分支 pill + 可展开的四合一面板，
覆盖「看状态 → 看改动 → 切分支 → 提交 → 回看历史」的本地 git 闭环。

- **收起态**：git 分支图标（lucide `git-branch` 细线描边，随主题着色）+ 当前分支 + 改动数徽标（按 暂存绿 / 未暂存橙 / 未跟踪青 分色，>9 显示 `9+`）
- **改动**：文件清单（状态字符 + 路径）、关键词过滤、单文件 diff 抽屉（`+N -M` 着色）、
  单文件暂存/取消暂存/丢弃（丢弃需确认）、全部暂存 / 取消全部暂存
- **分支**：搜索 + 本地分支列表（当前 ✓），点选 → 二次确认 → `git checkout`
- **提交**：提交信息 →「全部暂存并提交」（二次确认）；最近 10 条提交（hash/标题/作者/时间/refs），
  点选查看 commit diff（复用 diff 抽屉）
- **安全**：checkout / commit / discard 全部显式确认；脏工作区或失败时展示 git 原始报错，
  不自动 stash、不碰未确认数据；非 git 工作区 / 无会话目录自动隐藏
- **刷新**：15s 轮询 + 窗口聚焦刷新 + 每次变更操作后即时刷新
- **本期不做**：新建分支、ahead/behind、远程操作（`/sidebar/api` 无对应端点）

后端复用既有端点（零宿主新代码）：

| 端点 | 提供方 |
|------|--------|
| `GET /api/dsh-files/session-cwd?sessionId=…` | dsh-file-changes |
| `POST /sidebar/api/git.status / git.branch / git.checkout / git.diff / git.stage / git.unstage / git.commit / git.discard / git.log / git.commit-diff / fs.read` | dsh-better-sidebar |

纯逻辑核心挂 `window.__dshGitBranchCore`（node vm 可测，见 `dsh-desktop/test/git-branch-island.test.ts`）。

EAC 原研插件，经 companion-sync 注册表随内置插件同步加载。规划见
`dsh-desktop/docs/GIT-BRANCH-ISLAND-PLAN.md`。
