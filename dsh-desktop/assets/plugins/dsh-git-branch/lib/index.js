/**
 * dsh-git-branch — host half (no-op).
 *
 * 「git 分支显示与切换」（输入区 chip，可被输入灵动岛收编）：
 *   · 显示当前会话工作区的 git 分支 + 脏区圆点；
 *   · 点选下拉面板列出本地分支，二次确认后切换；
 *   · 脏工作区 / checkout 失败时展示 git 原始报错，不自动 stash。
 *
 * 全部 git 操作委托 dsh-better-sidebar 的 /sidebar/api（git.status /
 * git.branch / git.checkout），会话工作区路径取自 dsh-file-changes 的
 * /api/dsh-files/session-cwd —— 浏览器半边自包含，本半边仅让包成为
 * 合法 bundle。
 */
export const name = 'git-branch';
export const inject = [];
export function apply() {
  // no-op.
}
