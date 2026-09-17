# 外部文件拖入 Lexical 输入框设计

## 目标

允许用户从 Windows 资源管理器把文件拖入对话输入框。拖放只在输入框区域生效，
不会拦截消息区、侧边栏、文件树或其他页面区域。

## 现状与根因

`dsh-file-drop-eac` 已监听全局 `dragover` / `drop`，但仍按旧版 React 受控
`textarea` 的 `value` setter 注入内容。当前输入框已经迁移为 Lexical
`contenteditable`，元素标记为 `[data-composer-input]`，因此文件能被识别但内容
无法进入真实 draft 状态。

此外，部分升级 profile 仍残留旧 `file-drop / dsh-file-drop` 的 patch 行和包
副本，导致旧插件与 `file-drop-eac` 同时监听拖放。旧插件会继续接管图片和普通
文件，与官方图片附件插件及新版文件卡片链路发生竞争。

## 方案

插件通过 `conversation.input.overlay` 注册不可见捕获组件，持续获取当前会话的：

- `sessionId`
- `useInput` 提供的最新 draft
- `inputActions.setDraft`

选择 `conversation.input.overlay` 是因为它会随普通输入框和空白新会话的 Hero 输入框
一起渲染；`conversation.composer.dock` 在 Hero 状态下不会渲染，无法覆盖首次输入。

拖放事件使用捕获阶段监听，但只有事件目标位于 `[data-composer-input]` 内时才
调用 `preventDefault` 并处理文件。文本、二进制、超大文件、图片和文件夹继续
沿用现有分类规则。

普通文件落下后先在输入框顶部显示文件卡片，卡片包含文件名、大小、准备状态和
移除按钮。点击文本文件卡片可以查看最多 16KB 的文本摘要；二进制文件显示文件
信息和临时路径。

桌面端通过 `fileDrop.save` 保存不超过 64MB 的临时副本，写入时以捕获到的最新
draft 为基础追加紧凑路径引用，再调用官方 `inputActions.setDraft`，不再把完整
文本铺进 Lexical 输入框。只有路径保存失败时，体积上限内的文本文件才回退到原
有的内容注入，保证浏览器环境仍可用。异步处理多个文件时同步更新本地 draft
快照，防止后完成的文件覆盖先完成的结果。

## 交互

文件进入输入框时，在输入框卡片上显示高亮和“释放以添加文件”提示。普通文件、
纯图片和混合批次按以下方式分流：

- 纯图片完全交给官方图片附件插件，继续显示官方缩略图。
- 普通文件由本插件在捕获阶段独占，阻止官方图片遮罩误激活。
- 混合批次由本插件拆分，普通文件进入文件卡片，图片通过只含图片的新 drop 事件
  转交官方附件链路。

拖离、释放、窗口失焦或插件卸载时清除本插件提示，并发送 `dragend` 重置官方
图片拖放深度，避免遮罩停留在全屏。

升级同步把旧 `{ id: file-drop, name: dsh-file-drop }` 登记为退役内置插件，
通过现有精确迁移机制移除其 patch 行、profile 包副本和依赖，同时保留
`file-drop-eac` 行与包。

## 兼容边界

- 仅接管带 `Files` 类型且目标位于输入框的拖放。
- 图片仍不由本插件注入，保留给现有图片处理链路。
- 文件卡片是会话内的运行时草稿状态，刷新页面后不恢复，与官方待发送图片一致。
- 移除文件卡片时会尽力精确移除对应的 draft 引用；用户已改写该引用时不改其他文本。
- 没有当前会话或 `inputActions` 时不修改 draft。
- 保留旧 `textarea` 输入框定位作为兼容兜底，但写入统一走会话 input API。
- 事件监听和提示 DOM 必须在插件卸载时清理。

## 验证

- 单元测试覆盖输入框目标判断、非输入框不拦截、draft 追加和 slots 捕获。
- 迁移测试覆盖旧 `file-drop` 被移除且 `file-drop-eac` 保留。
- 运行插件定向测试、TypeScript build 和相关插件注册/复制测试。
- 重启本地 EAC，确认新版 Lexical 输入框正常加载且插件无控制台错误。
