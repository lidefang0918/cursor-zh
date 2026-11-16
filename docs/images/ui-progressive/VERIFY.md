# 渐进披露 UI 验证

本文同时收录两类材料，请勿把它们当成同一种证据：

- 下面「浏览器模拟渲染」里的截图（`light-default.png` 等，无 `native-` 前缀）来自 Playwright + 系统 Chrome 打开正式 `apps/desktop/index.html`，由脚本注入 mock `window.engine`，**不是**原生 Tauri 窗口。
- 「Linux 真实 Tauri 窗口」里的 `native-*.png` 来自本机编译的 debug 二进制在真实桌面里的窗口（已裁掉桌面背景；还原确认只保留对话框，避免把临时测试安装路径写进仓库）。

## Linux 真实 Tauri 窗口（2026-11-16，Asia/Shanghai）

对象：PR12 分支上的 `apps/tauri` debug 二进制（`npx tauri build --debug`；为避免无关的 linuxdeploy AppImage 打包失败，后续构建使用 `--no-bundle`）。已在 Debian 上安装 Tauri/WebKitGTK 构建依赖。未做 macOS / Windows 原生窗口验证，**不能视为全平台通过**。

真实 GUI 流程（computerUse 只通过原生文件夹选择器选中一份独立解包的官方 Linux Cursor 3.29.9 安装根，不是系统默认安装）：

- 汉化成功：`native-localized.png`（已是中文界面，Cursor 3.29.9，已适配）
- Escape 取消还原后再次确认：`native-revert-confirm.png`
- 还原成功：`native-reverted.png`（还未汉化，一键汉化恢复为主操作）
- 还原后对引擎会改写的 4 个文件做 sha256 核对，4/4 与官方原版一致（workbench.desktop.main.js、workbench.glass.main.js、nls.messages.json、product.json）
- 主题切换（更早的非破坏核对，当时尚未修复下面两个首屏问题）：`native-theme-light.png`、`native-theme-dark.png`

已知现象与限制：

- 启动时有 AT-SPI / `dbind-WARNING`（辅助功能总线不存在），窗口仍可正常显示和操作。
- 曾用 `npx tauri build --debug`（带打包）时 linuxdeploy 打 AppImage 失败；debug 二进制本身编译成功，可用 `--no-bundle` 跳过该步。
- 本次未能缩小窗口。配置的默认客户区是 820×720，最小 640×600；不能据此声称窗口缩放已验证。
- 未找到 Cursor 时，「还原英文」曾作为主按钮出现（过往汉化记录仍在）；已改为没有当前安装时不展示，DOM 仍保留以便其它情境恢复。
- 同一初态下「详细信息」折叠在设置 `hidden` 后仍占布局。原因不是测试没设属性，而是作者样式 `.fold-toggle { display: flex }` 盖掉了 UA 的 `[hidden] { display: none }`（已在 WebKitGTK 2.54 与 Chrome 实测：`hidden=true` 时计算样式仍为 `flex`，高度约 35px）。已按现有 `#overlay[hidden]` 的写法补上 `.fold-toggle[hidden] { display: none }`，并用 WebKitGTK 离屏窗口 + Chrome 的布局级回归（不是只断言 DOM 属性）锁住；找到安装时「详细信息」与「日志」仍可见。「日志」在未找到安装时保持可开，便于看探测输出。`native-missing.png` 拍摄于该 CSS 修复之前，用来对照当时仍可见的「详细信息」折叠；修复后的未找到首屏需在重启后的真实窗口上只读确认。

## 浏览器模拟渲染（Playwright，不是原生窗口）

时间：2026/11/16 10:02:51（Asia/Shanghai）
对象：正式 `apps/desktop/index.html`（mock `window.engine` 仅由本脚本注入）。

通过 21 / 21，失败 0。

- [x] PASS 浅色默认还未汉化
- [x] PASS 浅色默认 3.29.9 已适配
- [x] PASS 浅色默认无堆叠说明书
- [x] PASS 浅色默认 无横向溢出 — {"sw":820,"cw":820,"bw":820}
- [x] PASS Tab 焦点可见 — {"id":"refresh","outline":"solid","w":"2px"}
- [x] PASS 深色主题已应用
- [x] PASS 深色默认 无横向溢出 — {"sw":820,"cw":820,"bw":820}
- [x] PASS 授权确认含钥匙串与 ad-hoc 说明
- [x] PASS 授权确认含尚未完全修复
- [x] PASS Escape 关闭授权确认
- [x] PASS 运行中一行状态
- [x] PASS 退出确认含保存与 ⌘Q
- [x] PASS 失败主操作是重试
- [x] PASS 详情含路径
- [x] PASS 已汉化显示还原 — revert=true localizeHidden=true
- [x] PASS 兼容模式可见
- [x] PASS 忙碌锁定主按钮
- [x] PASS 忙碌锁定刷新
- [x] PASS 窄窗 无横向溢出 — {"sw":640,"cw":640,"bw":640}
- [x] PASS console error 为 0 — 0
- [x] PASS pageerror 为 0 — 0

模拟截图仍放在本目录，文件名无 `native-` 前缀。
