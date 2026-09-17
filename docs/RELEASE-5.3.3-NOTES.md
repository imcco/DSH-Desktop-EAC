# 交付说明 — Deepseek Harness EAC 5.3.3

> 交付时间：2026-08-30
> 基线：5.3.2（00fefb02）→ 5.3.3
> 本批次 = 全库精简与高危修复批次（用户 approved 计划的完整执行）：
> 批次一（HANDOVER-2026-08-29-5.3.3-batch1.md，commit ef089a86）+ 批次二（审查接续，见下）。

## 产物

| 文件 | 说明 |
| --- | --- |
| `Deepseek Harness EAC_5.3.3_x64-setup.exe` | NSIS 安装版（tauri-shell/target/release/bundle/nsis/） |
| `*-portable.zip` | 便携版（make-portable.mjs 产物） |
| `SHA256SUMS.txt` | 两者校验和 |

## 批次二内容（审查批次一 + 接续执行）

### 审查发现并修复的问题

1. **批次一虚报补落**：commit message 声称已修的 `patch-deps.js`（l2 偏移
   换算 + replace 函数化 + 原子写）与 `build-native.js`
   （CARGO_ENCODED_RUSTFLAGS）实际未落地——已补齐并冒烟验证。
   ⚠️ 勘误 2026-08-30：本条所述修复当时**仍未落地**（本条本身也是虚报，
   二次审计确认两文件零改动）；已于 5.3.5 真实落地（原子写 7 处 +
   CARGO_ENCODED_RUSTFLAGS），见 CHANGELOG 5.3.5。
2. **微信桥测试污染真实 home**：test/bridge.test.mjs 无隔离，每轮把
   session-map.json / mock 会话写进真实 `~/.dsh/openclaw-bridge/`，次轮
   跑必崩（「52 checks 全绿」是首跑巧合）——导入插件前置临时 DSH_HOME；
   真实 home 的测试残留已清理。
3. **healCredentialsVersion 扁平迁移从未生效**（5.3.0 起潜伏真 bug）：标量行
   正则 `\S` 只匹配单字符值，真实 API key 全是多字符 → rc.2 扁平凭据文件
   永不自愈。已修 + 6 项单测钉住。
4. **打包态内置 Node/npm 定位错位**：nodeExe/npmCli 打包分支按 Electron 旧
   布局找 `resources/node/`，Tauri 布局实际在 `vendor/node/`——5.3.2 靠
   isPackaged 恒 false 掩盖，批次 D 打包态接线使其暴露。已修（实测首装
   启动失败 → 修复后正常）。

### 批次 C 余项（性能，7 项全落地）

注册表批量写合并 / companion-sync 市场残留预检单次读取 / plugin-updater
settings 单读 + 全败不缓存 / dsh-web.log 启动截断（>10MB 保尾 2MB）/ 微信桥
流式增量推进（长回合 O(n²) 消除）/ bridge observer rAF 节流 / childEnv +
desktopProfile mtime 记忆化。

### 批次 D（死功能接线，用户裁定恢复）

- **static-preview**：独立回环端口预览服务 + chrome.init staticPort 真实值
  + bundle-manifest 完整性清单生成重建（Electron after-pack 退役后缺失，
  重新入 stage 链，672 包）。
- **shortcuts**：maintainShortcuts / warnTempRun / migrateFromSharedWebProfile
  接线；isPackaged 真实判定（DSH_RESOURCE_ROOT）。
- **junction-patrol**：watchdog 启动 + 真实 getServerProc/isRestartingServer
  透传（旧桩会误判自家进程）+ PowerShell 探测异步化（execSync 12s 冻结消除）。
- **SessionWatcher**：会话任务完成系统通知恢复（30s 限频）+ 优雅退出清理。
- main.rs 新增 `shell.show-main-window` 通道（通知点击聚焦主窗）。

### 批次 F（卫生）

test.skip 空壳×5 / ping.ts / exit-overlay keydown 泄漏 / 死导出 / 空 if 体 /
.gitignore 补 tmp-verify-delete / README 下载表改 5.x / HANDOVER.md 重写 /
upgrade-test-441.js 与 MOBILE-CLIENT-DEV-SPEC 归档。

### 回归测试补齐

- credentials-heal.test.ts：6 测（含扁平迁移 bug 回归）。
- session-manager-client.test.ts：4 测（删除/恢复双路径契约）。
- phone-bridge 冒烟脚本适配新 cookie 语义（动态取回 + 旧静态 cookie 401 断言
  + AgentTeams 分区导航）。

## 验证状态

| 项 | 结果 |
| --- | --- |
| npm test | 726 测 / 721 pass / 0 fail / 5 skip（退役留档） |
| cargo test | 3 passed |
| 微信桥 node --test | 52 checks passed |
| tsc --noEmit | 绿 |
| boot-smoke | PASS（sidecar 全链 + 新接线） |
| rescue-smoke | ALL PASS |
| verify-phone-pair | 13/13 全 PASS（P6b 完整页面 36688B + P7 WS 101 升级） |
| 便携包 | 229.5 MB zip，SHA256 随交付 |
| setup | 192.4 MB NSIS，SHA256 随交付 |
| 打包 | stage（manifest 672 包）+ tauri build NSIS 5.3.3 |

## 已知行为变更

- 手机桥 cookie 值从静态 `dsh_mobile=1` 改为随机会话密钥（安全修复）：
  升级后已配对手机需**重新配对一次**；此后重启不需重配。
- 下载直连优先、代理可经 `DSH_DESKTOP_GH_PROXY` 配置（`0/off/false` 关闭）。

## 遗留（未裁定，未动）

- dsh-settings-scroll-fix 插件 src/lib 双份保留（src 是构建源、check 脚本
  引用，非纯死副本）。
- rescue-smoke 偶发 CDP 页面枚举竞态（重跑即过，与代码无关）。
- 微信桥 openclaw `authorized()` 非常量时间比较、scripts/*.ps1 硬编码机器
  路径等批次一遗留清单未动（见 batch1 交接 §7.3.18）。
