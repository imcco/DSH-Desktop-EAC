# 内核升级差异清单：0.1.1-rc.2 → 0.1.2-alpha.1（spike 实测 2026-08-28）

> 依据：GitHub tag `dsh-v0.1.2-alpha.1`（commit cd5ef81）源码全量构建（build:official + release:pack 双家族 250 tarball）+ scratch profile 实机冒烟（浏览器侧 agent-browser 验证）。
> 构建缓存：`vendor/kernel/0.1.2-alpha.1/`（gitignored，重建 = `npm run fetch-kernel`）；接线 = `npm run gen-kernel-overrides && npm install`。

## 一、获取与构建（阶段 0 已完成）

- npm 未发布 0.1.2-alpha.1（npmjs/npmmirror dist-tag 均停在 rc.2），只能源码构建。
- pnpm 必须 11.7.0（packageManager 钉死；build.ts 内部再起 pnpm 子进程，corepack 版本切换失效 → 全局装 pnpm@11.7.0 直调）。
- Windows 构建补丁 2 处（fetch-kernel.ts 自动施加，只动构建工具脚本不动产物）：pack.ts 裸 spawn('pnpm') ENOENT → pnpmInvocation；tarball.ts 的 tar 盘符 → --force-local。
- `DSH_CLIENT_COMMIT_HASH=cd5ef81`（构建元数据要求；tarball 无 .git）。
- pack 输出按家族分目录（--out dist/npm-dsh / dist/npm-vendor，脚本会 rmSync 输出目录）。
- **发布面依赖缺口**：13 个内核共享包无人声明依赖（monorepo workspace 互链掩盖）：dsh-attachment/dsh-brand/dsh-client-store/dsh-client-ui-primitives/dsh-client-ui-slots/dsh-credentials/dsh-hook-protocol/dsh-jobs/dsh-sdk-protocol/dsh-session-persistence/dsh-session-query/dsh-settings/dsh-util-workspace-path。gen-kernel-overrides.ts 的 KERNEL_DEP_GAPS 固化补齐。
- npm overrides 规则：override 指向直接依赖时值必须与 spec 完全一致（EOVERRIDE）→ 直接依赖也写 file:tarball。

## 二、鉴权（实测矩阵）

| 探测 | 结果 |
|---|---|
| stdout 就绪行 | `dsh web: http://127.0.0.1:PORT/?token=<43char>`（现正则 `\S+` 可捕获）✓ |
| 裸 `GET /` | **401**（"dsh web authentication required"）——现壳 HTTP 探测接受 `<500` 会抢先返回裸 URL → 白屏，须改造 |
| 静态资源（/favicon.svg 等） | **200 免鉴权** —— 探测改用静态路径即可保持现有语义 |
| `GET /?token=...` | 303 → `/` + Set-Cookie `dsh-auth-<authority-hash>`（HttpOnly; SameSite=Strict; Max-Age=30d 默认；authority=Host 头含端口）|
| 带 cookie `GET /` | 200 |
| `POST /api/*` 无 cookie | 401；带 cookie → 404（endpoints 正常分发）|
| token 能否外部指定 | **否**（进程内 WeakMap 随机生成，无 CLI/env 口）|
| cookie 签名密钥 | 持久化在 credential store（跨内核重启有效，maxAge 内无需再兑换）|
| Host/Origin 围栏 | loopback 天然信任；`--host 0.0.0.0` 被拒；`--trusted-host <authority...>` 新 flag（手机桥改写 Host 的现方案恰好兼容，无需 trusted-host）|
| `/plugins/**` bundle 路由 | 免鉴权可配 cookie（404/200 均可达）|
| WS | 携带 cookie（浏览器同源自动带）——手机桥透传 Cookie 头即可 |

## 三、架构性变化（实测+源码）

1. **profile 引导职责移位**：`dsh web` 不再 pnpm 安装 profile；安装对账在 `dsh plugin`（"initialize the profile on first use"）。bundle 解析改为**优先从内核安装闭包**（app-boot resolveBundleDir：installAnchor → profile package.json），profile node_modules 仅 fallback。
2. **共享 fallback 机制**：内核启动自动把安装闭包 BFS 铺 symlink 进 `$DSH_HOME/profiles/node_modules`（healProfilesModuleFallback，220+ 链接秒级完成）——rc.2 时代桌面壳手工建 schemastery junction 的需求消失（但老 junction 不冲突）。
3. **`__DSH_BOOT__` 空数组是正常态**：内核自身 UI 全部打进 vite dist（index-D-*.js），boot graph entries 只承载**第三方插件** client 行。rc.2 时代"内核 client 包也是 entry"的判定作废。
4. **客户端批次路由**：`/plugins/??<id1>/client.js,<id2>/client.js&rev=<hash>`（组合批次，immutable）；单 entry URL 兼容存在。加载方式 = modulepreload link + 动态 import。
5. **第三方插件装载链路（实测通过）**：profile node_modules 放包 + cordis.patch.yml insert 行 → loader 装载宿主半（apply 语义不变）→ ClientModuleRegistry 扫描 entries → dsh.client 声明进 boot graph → 批次下发 → `window.__ModuleLoader__.load({id, factory})` 注册 → create() 按 inject 图装配执行。
6. **缺失注入的行为（关键实测）**：inject 指向不存在包名时——entry **仍在图**、批次仍下发、工厂仍执行，但 `ctx === undefined`（不是带 undefined 键的对象）→ 旧插件首行 `ctx.settingsScope` 抛 TypeError → **崩溃隔离在该 entry**（页面其余正常，app 挂载不受影响）。即：旧插件"静默失效"，不是炸页。
7. **不自注册的响亮报错**：声明 `exports["./client"]` 但 bundle 没 `__ModuleLoader__.load()` 注册 → "loaded without registering ... via __ModuleLoader__.load" 拖垮整个 Failed-to-load-plugins 横幅（页面仍活）。compat 包必须用 load() 注册式（CJS module.exports 不行）。
8. **兼容包不命中注入（方案裁决）**：把 `@deepseek-ai/dsh-client-runtime` 作为 profile 插件行装进去，它进图、它的 client 也执行，但**旧名注入的第三方插件 ctx 仍是 undefined**——bootstrap 装配第三方 entry 的注入来自内核模块表，不会消费另一个第三方包的导出。→ **兼容走 bridge.ts 垫片**（现有 `__ModuleLoader__.create()` 包装点扩展：拦截 create(options) 的 options.ctx/注入表，把旧名映射到新模块表实际对象；或包装 import 解析）。25 个内置插件的 manifest inject 可直接批量迁移（自有资产），第三方插件靠垫片。
9. **loader v2 解析签名 bug（真·内核 bug，须壳层补丁）**：Node ≥24.11 下 cordis-plugin-loader 的 internal.resolveSync 实际签名是 `(specifier, parentURL)`，内核 client-modules 按 v2 分支调 `(parentURL, {specifier})` → 全部 `located-undefined` → **boot graph 空、所有第三方插件 client 失效**（官方 CI 没抓到：官方 UI 走 vite 不依赖此路径）。修复=一行（v2 分支同样用位置参数 `internal.resolveSync(loaderName, baseUrl, {}).url`）→ patch-deps.ts 锚点补丁固化。实测修复后 49 entry 全部进图。
10. settings.mutate 线格式：对象参数 `{ns,ops,expectedRevision}` → 位置参数 `(ns,ops,revision)`；SettingsScope 类型移到 `@deepseek-ai/dsh-client-ui-settings/client`（settings-contract.ts）。
11. 新官方扩展位（增补，无迁移负担）：`settings.models.provider-card` / `settings.models.footer` 槽（ui-settings-models slot-contract）；locale `addLanguage({id,label,fallback})` 第三方多语言注册。
12. APIProxy 移除 → `dsh-host-apiproxy` 不存在：`patch-session-manage.js`（workspace.unarchiveSession/deleteSession 注入）锚点失效待移植；soul-md/picturereader 的 settings-expose vendor hack 失效待移植。
13. patch-deps 锚点命中情况（npm install 后实测）：**7/8 直接命中**（picker-native worker 退出码 / settings-general 滚动 / escalation×3 / agent-preset 子菜单 / web-frontend 主 bundle 悬停）；"Menu submenu item" 未匹配（待重锚）。
14. CLI 兼容面：`--profile/--patch/--host/--no-open/--port` 全部不变；`web` 仍是 `--profile web` 硬编码别名。
15. 内核适配器上报活动插件包名/版本（默认开）——隐私开关待定位（阶段 2 落地）。

## 四、桌面壳改造清单（按阶段）

- 阶段 2：boot-server 探测改静态资源路径（401 不再误判就绪）；`waitUntilUp` 的 `url+'/'` 改 query-aware；壳窗口首载 stdout 带出的 token URL；手机桥：上游 401 时用当次 boot 的 token URL 做一次兑换、Set-Cookie 透传手机侧 + WS 透传 Cookie；内核重启 token 轮换 → 桥跟踪 boot 状态重铸。
- 阶段 3：patch-deps 新增 client-modules v2 签名修复（锚点=resolveSync 三元分支）；bridge.ts 垫片扩展（create() 包装注入旧名映射）；patch-session-manage 移植或删除；soul-md/picturereader settings-expose 移植；Menu submenu 锚点重锚；25 个内置插件 manifest inject 批量迁移脚本（dsh-client-runtime → 按新包面拆分）。
- 既有正资产：companion-sync 的 insert 行格式/装载语义不变；`.dsh-builtin-plugins.json` 市场防重装机制不变；plugin-ops 的 patch 行增删语义不变。

## 五、遗留风险

- alpha 版内核自身 bug（如 v2 签名）可能还有暗雷——靠阶段 4 全量回归兜底。
- `healProfilesModuleFallback` 的 symlink 在 Windows 用 junction（代码兼容）。
- 内核 UI 全量 vite 化后，bridge.ts 哈希类名救援垫片（.wSkVaW_* 等）需逐个重锚（阶段 3）。
