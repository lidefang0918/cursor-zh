# 渐进披露 UI Implementation Plan

> **For agentic workers:** 本计划已批准在 box 上直接实施，无需再问执行方式。不要用 CloudAgent，不要改用户 Mac，不要在本分支做版本适配。

**Goal:** 把已批准的专家优先渐进披露交互接入正式 Tauri/Electron 界面，并接到真实 `window.engine` / Tauri invoke，而不是复制原型的场景切换或模拟进度。

**Architecture:** `apps/desktop/index.html` + `apps/desktop/renderer.js` 仍是界面源；改完后运行 `node scripts/sync-tauri-ui.mjs` 同步到 `apps/tauri/ui`。引擎、签名、证书、提权算法不动。测试用 mock bridge 与正式代码分离。

**Tech Stack:** 现有 HTML/CSS/JS，`node --test`，Playwright + 系统 Chrome 做渲染与截图。不新增产品框架或构建链。

## Global Constraints

- 基于远程 main / v0.2.5（aa605ca），不是旧的 605eed3。
- 文案简体中文，专业不说教；风险措辞以正式 README/CHANGELOG 和现有 renderer 为准，不盲从原型。
- 取消系统钥匙串授权时中止本次重签名、不回退 ad-hoc（与文档一致）；不要声称已解决 Mac SIGKILL / CS_KILLED。
- 未支持能力不显示假按钮（例如仅 Tauri 有 `pickRoot`）。
- 不把原型演示开关、模拟进度、示例日志带进产品。
- 提交不含本机用户名路径；不合并、不打 tag、不发 Release，不评论或关闭 issue。
- 版本升级 issue 另开阶段，本分支只做 UI。

---

### Task 1: 红灯 — UI 状态/DOM 测试

**Files:**
- Create: `packages/engine/test/helpers/ui-dom-harness.mjs`（仅测试：最小 DOM + mock `window.engine`）
- Create: `packages/engine/test/ui-dom.test.js`

- [ ] 写失败测试（对当前 UI 应为红）：默认未汉化已适配首屏不堆管理员/运行中/签名说明书；主操作与版本/状态/适配可见；成功时还原为次操作且不占永久主按钮；路径/词典/诊断/日志按需展开并记住偏好；主题为浅/深/系统紧凑选择并持久化；刷新在标题区；运行中仅一行，点击后确认正常退出（⌘Q / 关闭按钮，非强制结束）；macOS 操作前确认系统钥匙串信任与已知限制，取消即中止；失败主操作是符合下一步的「重试」；签名校验失败不以「重试必能修好」为主操作；忙碌时锁定冲突按钮；Escape 关闭确认；Tab 焦点可见。
- [ ] 跑 `node --test packages/engine/test/ui-dom.test.js`，确认因缺少新结构而失败，而不是 harness typo。

### Task 2: 绿灯 — 改正式界面并同步

**Files:**
- Modify: `apps/desktop/index.html`, `apps/desktop/renderer.js`
- Modify: `apps/desktop/main.js`, `apps/tauri/src-tauri/src/main.rs`（按旧结构选最小窗口，默认可略降高度，min 仍须放下确认/命令提示，不裁切）
- Run: `node scripts/sync-tauri-ui.mjs`
- Keep: `apps/tauri/ui/tauri-bridge.js`, `apps/desktop/preload.cjs` 的 engine 方法；不改 packages/engine 签名/提权实现。

保留全部现有情境：多安装、手选、AppImage 解包、管理员命令（复制 + 我已执行，继续）、MAC_APP_MANAGEMENT / 隔离路径、兼容/无法汉化、更新词典、更新后失效、真实日志、NEED_ELEVATION / CURSOR_RUNNING 回退路径。

- [ ] 实现后 `node --test packages/engine/test/ui-dom.test.js` 转绿。
- [ ] `npm test` 全绿（含原有 tauri 同步/桥接/⌘Q 文案断言）。

### Task 3: Playwright 真实渲染、截图、README

**Files:**
- Create: `scripts/verify-ui.mjs`（mock bridge 仅测试用，系统 Chrome，不入库新依赖）
- Modify: `README.md` 中与本工具界面有关的截图/步骤，按真实能力写。
- Replace only UI shots: `docs/images/app-localized.webp`, `docs/images/app-reverted.webp`, `docs/images/app-confirm-close.webp`（必须来自正式 UI）。

- [ ] 覆盖默认浅/深、确认、错误、详情、进度锁定、窄窗无溢出、Escape/焦点。
- [ ] 若 Linux 可编译 Tauri，再做实际桌面窗口检查；不能伪称已验证 Mac/Windows。
- [ ] 截图后人工逐状态检查。

### Task 4: 提交、push、开 PR（不合并）

- [ ] 本地 commit（可分测试/实现/文档，但不把版本适配混进来）。
- [ ] push `ui/progressive-disclosure`，用 GitHub 工具建 PR 到 main。
- [ ] 只读列出当前 3 个开放版本升级 issue，等主助手复核后再做下一阶段。
