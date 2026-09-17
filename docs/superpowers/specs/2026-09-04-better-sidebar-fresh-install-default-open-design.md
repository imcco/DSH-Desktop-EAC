# better-sidebar 全新安装默认展开设计

## 目标

全新安装 Deepseek Harness EAC 时，`dsh-better-sidebar` 的“新会话默认打开”
开关默认为开启。已有安装升级后保持现状，已有会话布局和用户手动选择不变。

## 方案

EAC 在首次生成 `better-sidebar` profile 插件行时写入：

```yaml
config:
  openByDefault: true
```

`dsh-better-sidebar` 将该部署配置作为用户设置命名空间的 base 层。用户设置层仍
拥有更高优先级，因此用户关闭开关后会稳定保持关闭。

现有 profile 中已存在的插件行不会被 `syncCompanionPlugins` 重写，因此升级用户
不会获得这个新 base。插件自身在没有部署配置时继续使用 `false`，覆盖通过 bundle、
市场或历史 profile 加载的既有安装。

## 行为边界

- 只影响尚未产生会话布局的新会话。
- 已持久化的会话布局优先，不因默认值变化重新展开。
- 窄屏和宿主剩余宽度保护继续生效。
- 用户设置中的显式 `true` 或 `false` 均覆盖部署 base。
- 不增加迁移，不扫描或改写已有 profile。

## 验证

- 锁定 `COMPANION_PLUGINS` 的新安装配置。
- 锁定插件配置缺省仍为 `false`。
- 锁定设置注册使用部署配置作为 base。
- 运行 better-sidebar 定向测试、TypeScript build 和相关 profile/插件测试。
