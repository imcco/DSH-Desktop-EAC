// Host-side entry for dsh-conversation-tweaks:
// registers the durable settings namespace used by the General-settings row.
import z from "@deepseek-ai/schemastery";
// 0.1.3：dsh-settings 移除两个独立导出 —— 改走共享兼容垫片（行为逐行一致）。
import { installSettingsSection, settingsNamespace } from "./settings-compat.js";

const name = "@deepseek-ai/dsh-conversation-tweaks";
const inject = ["settings"];

const NS = settingsNamespace("dsh-conversation-tweaks");
const Config = z.object({
  quietOutput: z.boolean().default(false)
});

function apply(ctx, config) {
  // settings 已在本插件 inject 中声明，apply 时服务必在；直接同步注册并
  // try/catch：存储的 dsh-conversation-tweaks 配置节非法会让 register()
  // 抛异常 → 插件 fiber 失败 → dsh fail-loud 启动崩溃。降级运行（不阻断启动）。
  try {
    const scope = ctx.settings.register(NS, Config, { base: config || {} });
    // 客户端通过 settingsScope 订阅热更新，这里无需额外缓存。
    return () => { void scope; };
  } catch (error) {
    console.warn("[dsh-conversation-tweaks] settings section unavailable (invalid stored config): " + ((error && error.message) || error));
  }
}

export { Config, apply, inject, name };
