# macOS 本机 boot 冒烟记录（阶段 0 复核）

> 日期：2026-09-17 · 机器：Apple M3 Pro / macOS 26.6.2 (arm64)
> 被测产物：`/Applications/Deepseek Harness EAC.app`（5.4.1，本机 2026-09-17 15:14 构建）
> 目的：复核 `dsh-web.log` 中最后一次启动失败（`PERSONA_SECTION` 导出缺失）是否已随 15:27
> 的手工修复消失。
> 结论：**未消失。该手工修复会被 App 自身在每次启动时覆盖回去。必须从当前源码树重建。**

## 一、环境基线

| 项 | 值 |
| --- | --- |
| 硬件/系统 | Apple M3 Pro · macOS 26.6.2 (25G83) · arm64 |
| Rust | cargo 1.88.0 · rustc 1.88.0 · target `aarch64-apple-darwin` 已安装 |
| C 工具链 | `/Library/Developer/CommandLineTools`（Apple clang 21.0.0） |
| Node | 系统 v22.22.2 · Homebrew `node@25` v25.9.0 |
| 随包运行时 | `vendor/node/node` = Mach-O arm64（版本 v22.22.2） |
| Gatekeeper | `spctl --status` → **assessments disabled**（本机全局关闭） |
| `.app` 签名 | adhoc / linker-signed；`Info.plist=not bound`；`Sealed Resources=none`；`codesign -v` 报 `code has no resources but signature indicates they must be present` |

## 二、启动前状态

| 检查 | 结果 |
| --- | --- |
| EAC 进程残留 | 无 |
| 端口 19873 (WS 中继) | 空闲 |
| 端口 59357 (Web) | 空闲 |
| `dsh-web.log` | 76225 B，mtime 2026-09-17 15:18:46（含上次失败栈） |

## 三、启动与观测

1. `open "/Applications/Deepseek Harness EAC.app"` → 拉起成功。
2. 进程出现：
   - 壳：PID 6345 `/Applications/.../Contents/MacOS/dsh-eac-shell`
   - sidecar：PID 6348 `/Applications/.../Contents/Resources/dsh-desktop/vendor/node/node .../sidecar/server.js`
3. WS 中继端口 19873 正常 LISTEN（`dsh-eac-s 6345`）；sidecar 自身 LISTEN 于 49417。
4. **Web 服务未起来**：`curl http://127.0.0.1:59357/` → `HTTP 000`（16.4s 超时）；
   `/openclaw-bridge/health` → `HTTP 000`。
5. `dsh-web.log` 由 913 行增至 969 行，新增的正是**同一处失败栈**，
   但栈内路径已切换为 `/Applications/Deepseek Harness EAC.app/...`（= 本次运行）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry prompt-custom (@deepseek-ai/dsh-prompt-custom):
The requested module '@deepseek-ai/dsh-system-prompt' does not provide an export named 'PERSONA_SECTION'

  file:///Users/chongchen/.dsh/profiles/web-desktop/node_modules/@deepseek-ai/dsh-prompt-custom/lib/index.js:21
  import { PERSONA_SECTION, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
```

## 四、根因（已实证）

四处 `dsh-prompt-custom/lib/index.js` 的 mtime 与内容对照：

| 位置 | mtime | 第 21 行导入 | 判定 |
| --- | --- | --- | --- |
| 仓库源码 `dsh-desktop/assets/plugins/dsh-prompt-custom/lib/index.js` | 15:27:19 | `PERSONA_PREFIX_SECTION` | ✅ 已修 |
| `/Applications/...app/Contents/Resources/dsh-desktop/assets/plugins/...` | 15:12:26 | `PERSONA_SECTION` | ❌ 旧构建自带 |
| `tauri-shell/target/release/bundle/macos/...app/.../assets/plugins/...` | 15:12:26 | `PERSONA_SECTION` | ❌ 旧构建自带 |
| `~/.dsh/profiles/web-desktop/node_modules/@deepseek-ai/dsh-prompt-custom/lib/index.js` | **15:56:20** | `PERSONA_SECTION` | ❌ **被本次启动覆盖回旧版** |

机制：`dsh-desktop/lib/desktop/companion-sync.ts` 把内置插件从 App 自带的
`assets/plugins/<dir>`（第 416/428 行）同步进 `~/.dsh/profiles/web-desktop/node_modules/@deepseek-ai/`
（`prompt-custom` 注册见第 192 行）。App 是最新版本 15:12 的旧构建，因此
**每次启动都会把 profile 里手工修好的插件覆盖回 `PERSONA_SECTION` 版本**。

旁证：内核侧 `@deepseek-ai/dsh-system-prompt@0.1.5-rc.2` 实际导出
`PERSONA_PREFIX_SECTION` / `PERSONA_SUFFIX_SECTION`，**不导出** `PERSONA_SECTION`
（已直接 `import` 验证）。故 15:27 的源码修复方向正确，profile 侧手工替换也确实有效——
只是无法在旧 App 上存活。

## 五、退出与零孤儿

| 路径 | 结果 |
| --- | --- |
| `osascript -e 'quit app "Deepseek Harness EAC"'` | ❌ 失败：`-10004 权限违例`（Automation/Apple Events 未获 TCC 授权） |
| `kill -TERM 6345` | ✅ 壳 1s 内退出，sidecar 被回收 |

退出后扫描：

```
pgrep -fl "dsh-eac-shell|sidecar/server.js|vendor/node"  → 无输出        ✅ 零残留
lsof -iTCP:19873 -sTCP:LISTEN                            → 无输出        ✅ 已释放
lsof -iTCP:49417 -sTCP:LISTEN                            → 无输出        ✅ 已释放
```

注意：Apple Event 退出失败是**本机 TCC 授权问题**，不是应用的退出缺陷；
SIGTERM 路径的进程回收表现完好。2026-08-27 的旧报告声称 `osascript` 退出成功，
应是在已授权 Automation 的终端下测得，不可直接照搬。

## 六、本次冒烟的旁证结论

| 检查项 | 结果 |
| --- | --- |
| `npm run typecheck`（tsc --noEmit） | ✅ exit 0 |
| `cd tauri-shell && cargo check` | ✅ exit 0，23.2s（3 条 `unreachable expression` warning） |
| `npm test`（需 Node ≥ 24） | ⚠️ 873 tests / 858 pass / **6 fail** / 9 skip |
| 随包 Node 版本 | ⚠️ v22.22.2 < test-runner 要求的 24 |
| App 内 `native/*/index.node` | ⚠️ PE32+ Windows x86-64 DLL（darwin staging 未裁剪 `native/`） |

6 个失败用例均**非 macOS 平台性问题**：

| 用例 | 根因 |
| --- | --- |
| `dsh-stt.test.ts:58` | 无 `.git`，`git check-ignore` 返回 128 |
| `linux-release-boot.test.ts` | `.github/workflows/release-tauri.yml` 不存在（workflow 已移入 `.deprecated/`） |
| `kernel-pin-consistency.test.ts:33` | `fetch-kernel DEFAULT_TAG=0.1.3-alpha.1` ≠ 钉住的 `0.1.5-rc.2` |
| `kernel-pin-consistency.test.ts:41` | `docs/archive/upgrade-test-441.js` 仍硬断言 `0.1.3-alpha.1` |
| `persona-scope.test.ts` ×2 | persona 配置 schema 现要求 `prefix`，用例未随 `PERSONA_PREFIX_SECTION` 更名同步 |

## 七、结论与下一步

1. **当时 App 不可用**：Web 服务起不来，主窗无法进入正常界面。
2. **修复方式唯一且明确**：从仓库当前源码树重建 `.app`。
   profile 侧手工替换无效——会被合入同步逻辑覆盖。
3. 重建前建议一并处理（否则会烧进新包）：
   - `tauri.conf.json` 版本 5.4.1 → 对齐 `package.json` 的 5.5.0；
   - 先 `node scripts/build-native.js build` 与 `... build snapshot`，避免把
     Windows `index.node` 装配进 macOS 包；
   - 以 Node ≥ 24 重跑 `npm run fetch-node`，让随包 Node 达标；
   - `node tauri-shell/stage-resources.mjs --target=darwin` → `npx -y @tauri-apps/cli@2 build`。

原始失败日志已备份至 `tmp-macos-smoke/dsh-web.log.before`。

---

# 附录：重建执行记录（同日完成）

## 执行差异（相对原计划，均经实证后调整）

| 计划项 | 实际处理 | 依据 |
| --- | --- | --- |
| 构建 darwin 原生模块 | **跳过** | `native/*/index.node` 全仓唯一消费者是 `job-fence.ts:89`，其第 91 行 `process.platform !== 'win32' → return null`；`native/snapshot` 零消费者。darwin 上为 100% 死载荷。且本机 DSH 文件沙箱禁止写 `~/.cargo`，构建会失败；为死载荷不申请提权。原 Windows `index.node` 已备份至 `tmp-macos-smoke/win-native-backup/`，源码树未被改动 |
| 随包 Node 升 24+ | **保持 22.22.2** | 日志中多次历史成功启动（`dsh web: http://127.0.0.1:59357`）均运行于 Node 22.22.2，内核 0.1.5-rc.2 兼容性有实证背书；升 25（Homebrew 唯一可选）会引入新变量。Node ≥ 24 仅作为开发侧 `npm test` 门槛，用 `PATH=/opt/homebrew/opt/node@25/bin:$PATH` 前置即可，与运行时分包无关 |
| `npx -y @tauri-apps/cli@2` | **直接调用 npx 缓存** | 沙箱禁写 `~/.npm`，`npx` 无法落盘新包；`~/.npm/_npx/adcdbcd7187d8bbb/node_modules/.bin/tauri`（tauri-cli 2.11.4）已存在且可读，直接调用 |

## 执行步骤与结果

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | `tauri-shell/tauri.conf.json` 版本 5.4.1 → **5.5.0**（`edit`） | ✅ 无测试对 tauri.conf 版本做强绑定（已核实） |
| 2 | `node tauri-shell/stage-resources.mjs --target=darwin --skip-npm` | ✅ exit 0；staged 内 `dsh-prompt-custom` 第 21 行已为 `PERSONA_PREFIX_SECTION`；node_modules 282 包；平台戳 `darwin`；descriptor 版本 5.5.0 |
| 3 | `tauri build --ci` | ✅ release 编译 26.95s；✅ `.app` 产出；❌ `.dmg` 失败 |
| 4 | `.dmg` 失败根因 | `hdiutil create` 在本沙箱报 `-60031 认证错误`——环境限制（hdiutil 需更高权限/TCC），非项目缺陷；`.app` 不受影响，`.app.zip` 可经 `ditto` 产出 |

## 新 `.app` 验证（仓库内 `target/release/bundle/macos/`）

| 检查项 | 结果 |
| --- | --- |
| Info.plist 版本 | 5.5.0 ✅ |
| 内带 `dsh-prompt-custom` 第 21 行 | `PERSONA_PREFIX_SECTION` ✅ |
| 二进制 | Mach-O arm64 ✅ |
| 启动（`open`） | 壳 + sidecar 拉起 ✅ |
| companion-sync 行为 | 启动瞬间（16:05:53）把**修复版**插件同步进 `~/.dsh/profiles/web-desktop`，覆盖掉旧 App 留下的坏副本 ✅ |
| Web 服务 | `dsh web: http://127.0.0.1:59357/?token=...`；带 token `curl` → HTTP 303（正常重定向），无 token → 401（鉴权生效）✅ |
| `/openclaw-bridge/health` | HTTP 200 ✅ |
| WS 中继 19873 | LISTEN ✅ |
| 优雅退出（SIGTERM 壳） | 壳 1s 退出；sidecar + dsh web 子进程 ~7s 内回收；19873/59357 释放；**零孤儿** ✅ |

## 遗留事项

1. `/Applications/Deepseek Harness EAC.app` 仍为 5.4.1 旧版（重建前用于复现根因）——**已用新 5.5.0 覆盖**。
2. 包内 `native/*/index.node` 仍为 Windows PE32+（死载荷，无功能影响）。正确修法是 darwin staging 分支加 `native/` 裁剪（需同步加回归测试），或恢复 `build:native` 的 CI 构建；本机沙箱无法构建，不在本次范围。
3. `.dmg` 需在有 hdiutil 权限的普通终端或 CI 中产出；本沙箱不可用。
4. Apple Event（`osascript quit app`）在本机被 TCC 拦截（-10004）；SIGTERM 退出路径完整可用。

