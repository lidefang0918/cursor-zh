# Box 实机验证记录（2026-10-29，Asia/Shanghai）

> 只在 Grok Bot 的 box（Debian 13，DISPLAY=:5）上的 Cursor 上做的验证，**没有碰用户自己电脑上的 Cursor**。未登录 Cursor。

## 环境与真实路径

| 项 | 值 |
|---|---|
| Cursor | 3.27.22 stable（apt 源 `cursor.list`），commit `b1aa50cb6db84fd3e8c808259cb172ea73425c10`，vscodeVersion 1.128.0，Electron 42 |
| 安装根 | `/usr/share/cursor`（root:root） |
| product.json | `/usr/share/cursor/resources/app/product.json`（`checksums` 的 key 相对 `resources/app/out`） |
| 经典 workbench | `resources/app/out/vs/workbench/workbench.desktop.main.js`（约 41MB，**在 checksums 里**） |
| Agents/glass workbench | `resources/app/out/vs/workbench/workbench.glass.main.js`（约 50MB，**不在 checksums 里**；3.x 默认的第一个窗口 “Cursor Agents”） |
| CLI | `/usr/share/cursor/bin/cursor`（`/usr/bin/cursor` 是软链） |
| 用户数据 | `~/.config/Cursor`（`languagepacks.json`、`clp/` NLS 缓存） |
| 扩展目录 | `~/.cursor/extensions`（`extensions.json` 是登记表） |
| locale | `~/.cursor/argv.json`（JSONC，字段 `"locale"`） |
| 本工具数据 | `~/.config/cursor-zh-localizer`（`state.json`、`backups/<version>/`、`cache/` 里的 vsix） |

## 实测结果

- `npm test`：**24 通过 / 0 失败**（node:test）。
- `node scripts/run.mjs localize`：ok。静态替换 **711 处**，0 条未命中，约 27 秒。product.json 只有 1 行变化（desktop.main 的 checksum），两个 bundle 都能通过 `node --check`。
- `node scripts/run.mjs revert`：3 个文件和原始 sha256 **逐字节一致**（`sha256sum -c` 全部 OK）。`argv.json` 里的 locale 已删除，语言包已从 `extensions.json` 注销。
- 语言包：Open VSX 最新版 1.131.0 要求 `engines ^1.131.0`，**不兼容** VS Code 1.128.0，所以按 `<maj>.<min>.0` 固定用 **1.128.0**。用 `cursor --install-extension` 在 headless 环境下能装上。第一次启动后 `languagepacks.json` 出现 zh-cn，并生成 `clp/<hash>.zh-cn/<commit>`，说明 NLS 已生效。
- 启动检查（未登录）：
  - glass 窗口连续两次启动都正常渲染，登录页显示中文（用 AI 写代码的最佳方式 / 登录 / 注册）。
  - `--classic` 经典窗口也正常，显示中文登录页。
  - 日志里没有 “安装已损坏” 或 checksum 告警。
- 词典：`dicts/zh-cn.json` 共 **126 条**，全部精确匹配。
  - **85 条**通过锚点静态替换（desktop.main 80 条，glass 83 条）。
  - **41 条**只靠 DOM 运行时补漏（短词或有歧义、用作逻辑值的字符串）。
  - 必需锚点：`Cursor Settings`、`Rules, Skills, Subagents`。
- Electron 外壳：`DISPLAY=:5 npx electron .` 能启动并保持运行（只有 dbus 噪音）。点击流程由上层验证。

## 过程中发现并已修复

1. **"DOM 扩展" 方案不可行**：扩展跑在 extension host，拿不到 DOM。已改为在 workbench bundle 末尾追加带标记的运行时（`/*CURSOR_ZH_DOM_BEGIN*/…END`），还原时从备份恢复即可去掉。
2. **3.x 有两个 workbench**：除了 desktop.main，还有 glass（Agents 窗口，不在 checksums 里）。现在两个都会静态补丁并注入 DOM 运行时。
3. **product.json 被整体重排**：原来是 `JSON.stringify` 重写。现在只做文本替换 checksum 的值，其余字节不变（有测试覆盖）。
4. **语言包残留目录误判为“已安装”**：`--uninstall-extension` 会留下目录，要等 Cursor 下次启动才清理，导致再次汉化时跳过安装、实际没登记。现在以 `extensions.json` 的登记为准（有测试覆盖）。
5. **首次汉化后 glass 窗口出现过一次空白**：日志里有 `Failed to create or load draft composer`。之后用 static-only、DOM-only、static+DOM 三种组合以及最终引擎产物各启动多次，**都没有复现**。判断是首次启动时的一次性现象（新语言包生成 NLS 缓存和 V8 code cache 重建时的竞态）。原因没有完全查清，列为 P1 观察项。

## 问题清单（按优先级）

### P0
- **需要管理员权限**：Linux deb/rpm 安装在 `/usr/share/cursor`，属主是 root。localize 会正确拒绝并提示“没有写权限”。box 上验证时是手动 `sudo chown` 了这 3 个文件。真实用户需要 GUI 提权（pkexec/sudo 包装，Windows 用 UAC），或者走用户级安装（AppImage 或 `~/.local`）。
- **每个 Cursor 版本都要一份锚点清单**：没有清单就拒绝修改（安全，但等于不支持新版本）。Cursor 更新后 bundle 会被覆盖，汉化失效，备份也对不上新版本。需要：用 `scripts/build-anchors.py` 做 CI 按版本生成清单；检测到版本变化时提示“重新汉化”，并丢弃旧备份。

### P1
- glass 首启空白（见上文第 5 条）：建议首启后自动检测，必要时提示再启动一次。
- 覆盖面：登录页底部的 “Cursor's AI features require you to be logged in”（弯引号）、原生对话框（如 OS keyring 提示）、Electron 主进程菜单都还是英文。登录后的大部分 Cursor 自有 UI 没能实机看到（任务要求不登录），覆盖率要在登录态下再评估。
- 静态替换的安全性靠启发式规则：排除 `===`、`case`、对象键、`[...]`、`.includes(`、`id:/type:/name:` 等用法。本版实测没有坏，但新版本必须重新跑分析和启动冒烟测试。
- DOM 运行时的风险：
  - 只做完全匹配，并跳过编辑器、终端、文件名（`label-name`、`monaco-icon-name-container`）。
  - 但 AI 回复或用户内容恰好等于某个词条时也会被翻译。
  - MutationObserver 在大 DOM 下的性能没有压测。
- 命令面板按英文搜索：语言包会提供 `original` 英文别名，但被静态替换的 Cursor 自有命令没有英文别名。

### P2
- 性能：localize 约 27 秒，主要是对 40–50MB 文件逐条 split/join 711 次。可以改成每个文件单次扫描。
- 语言包版本固定为 `<maj>.<min>.0`：如果 Open VSX 上没有对应版本，需要回退到最近的兼容版本（读取 `engines.vscode`）。
- 卸载后语言包目录残留，要等 Cursor 下次启动才清理（VS Code 自身行为）。

### Windows / macOS TODO
- 路径：Windows 是 `%LOCALAPPDATA%\Programs\cursor\resources\app`，macOS 是 `/Applications/Cursor.app/Contents/Resources/app`。detect.js 里目前只是桩，没有实测。
- macOS：修改 .app 内文件会破坏签名，可能需要 `codesign --force --deep -s -`，并处理 Gatekeeper 隔离；还要确认 `/Applications` 下的写权限。
- Windows：系统级安装需要 UAC；Cursor 运行时文件被占用；检测运行中的进程要用 tasklist。
- 用户数据目录：`%APPDATA%\Cursor` 和 `~/Library/Application Support/Cursor`；argv.json 都在 `~/.cursor`。
