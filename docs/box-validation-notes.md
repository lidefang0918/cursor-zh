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

## box 重启后重装 Cursor（2026-10-29 16:55，Asia/Shanghai）

box 重启会清掉 `/usr/share/cursor`（以及 apt 源 `cursor.list`），`~/.config/Cursor`、`~/.cursor`、`~/.config/cursor-zh-localizer` 都还在。

- **安装方式**：官方 apt 仓库里的 deb，用 `apt-get install ./cursor_3.27.22_amd64.deb` 安装（自动装依赖；postinst 会重新写 `/etc/apt/sources.list.d/cursor.sources`）。
- **URL**：`https://downloads.cursor.com/aptrepo/pool/stable/c/cu/cursor_3.27.22_amd64.deb`（223,442,636 字节，sha256 `863a9dd15ca5fe84dd2f8e74fe2e926e8b438692f202277a89dd0ec3d928bf98`，来自 `https://downloads.cursor.com/aptrepo/dists/stable/main/binary-amd64/Packages` 中的 `3.27.22-1793067078`；同一索引里还有 3.27.20）。
- **缓存**：`/workspace/cache/cursor_3.27.22_amd64.deb`；原版文件的 sha256 存在 `/workspace/cache/pristine-3.27.22.sha256`（可以 `sha256sum -c`）。
- **一键重做**：`scripts/reinstall-cursor-box.sh --chown`。脚本会校验缓存的 sha256，不对就重新下载，然后安装，并把 4 个汉化目标文件 chown 给 box（这是 box 专用的权限绕过）。
- 装好后是 3.27.22，commit `b1aa50cb…`，VS Code 1.128.0，和之前完全一致。4 个目标文件的 sha256 和旧备份 manifest 也逐个相同。

### 过期汉化记录（已修复，有测试）

- 重装后，`state.json` 还写着 `localized: true`，但安装文件已经是原版。
- 修复前：`status` 显示“已汉化”，`localize` 拒绝执行（“已汉化，如需重做请先还原”）。
- 修复前的 `revert` 还有更大的风险：它会拿旧备份去覆盖新安装。如果版本不同，就会把旧版本的文件写进新安装。
- 现在的做法：先检查安装文件里有没有 DOM 运行时标记，再对比 version 和 installRoot，据此判断记录是否过期。
  - `status` 新增 `patched`、`stale`、`localized` 三个字段。
  - `localize` 遇到过期记录时，会把旧备份改名为 `backups/<ver>.stale-<时间>` 留档，然后重新汉化。上次留下的语言包和原始 locale 会沿用，还原时能真正恢复，而不是恢复成 zh-cn。
  - `revert` 遇到过期记录时，不覆盖任何安装文件，只清理语言包和 locale。
  - 如果安装文件已带补丁但没有汉化记录，`localize` 会拒绝执行，避免把已补丁的文件当成原版备份。
  - GUI 会显示“汉化已失效（Cursor 被重装或更新），可重新汉化”。
- `npm test`：35/35 通过。

### 实测

- `localize`：经典窗口 538 处，Agents 窗口 763 处，NLS 163 条，0 条未命中，约 3 秒。
- `revert`：4 个文件对照 deb 原版 sha256 全部 OK（逐字节一致），locale 已删除，语言包已注销。
- 再次 `localize`：计数相同。
- 以 `DISPLAY=:5 setsid nohup /usr/share/cursor/cursor --disable-gpu` 启动（日志在 `/workspace/logs/cursor-run{1,2}.log`）。两次启动都**一次成功**，Agents 窗口是中文，没有空白，日志里没有损坏或 checksum 告警。当前已登录。
- 截图：`/workspace/shots/run1-{root,agents}.png`、`run2-{agents,classic}.png`。
  - 没能装上 imagemagick：box 上 apt 访问 deb.debian.org 时，出口代理返回 500，https 也会断开；但 curl 能访问。
  - 所以改用 `ffmpeg -f x11grab -video_size 1920x1200 -i :5 -frames:v 1 <png>` 截图。

### 登录态下仍是英文的可见文案

- 经典窗口：
  - 右侧聊天的标签页标题 “New Agent”：词典里有，但 DOM 运行时跳过了 tab label 类名。
  - 状态栏的 “Cursor Tab”、“Tab Stats: 0/0 (0%)”、“Agent Stats: 0/0 (0%)”：带数字的拼接串，精确匹配命中不了。
- Agents 窗口：右上角的 “IDE ↗”。
- 两个窗口都有：模型名 “Cursor Grok 4.6 Medium”（专名，应保留）。
- 另外，“GitHub”、“bug”、“/create-skill”、“/add-plugin”、文件夹名和用户名都应保留英文。

## 第 3 轮：剩余英文 + DOM 误翻风险（2026-10-29 17:00–17:10，Asia/Shanghai）

定位方法：临时用 `--remote-debugging-port=9333` 启动 box 上的 Cursor，用 `scripts/box-cdp-eval.mjs` 在渲染进程里查 DOM。验证完已改回普通方式启动，调试端口已关闭。

1. **经典窗口聊天标签页 “New Agent”**
   - bundle 里约 30 处 `"New Agent"`，大多是默认会话名、常量或比较值（`JHe="New Agent"`、`name||"New Agent"`），静态替换不安全。
   - 标签页标题渲染在 `.composer-tab-label .label-name` 里，而 DOM 运行时为了保护文件名，会整棵跳过 `label-name`。
   - 现在：`label-name` 位于 `composer-tab-label` 内时，**只翻默认标题**（New Agent / New Chat → 新建智能体）。用户自己起的会话名和普通文件名都不动（有测试）。
2. **状态栏 “Tab Stats / Agent Stats”**
   - 文案是模板字面量 `` `$(tab) Tab Stats: ${…}/${…} (${e}%)` ``。
   - 静态层新增 `fragments`：带上下文的固定片段，出现次数必须和锚点里的 `count` 一致才替换，否则跳过并记为未命中。3.27.22 每个 bundle 12 处，共 24 处。覆盖状态栏文字、悬浮提示 “(Today) … lines” 和 ariaLabel。
   - DOM 层新增 `dicts/zh-cn.patterns.json`：`{n}` 只匹配数字（`\d[\d.,/]*`），只在外壳区域生效（statusbar、titlebar、tabs-container、hover、action-bar），文本不超过 120 字符，作为静态层的兜底。
3. **Agents 窗口 “IDE ↗”**
   - 只有 `aria-label:"IDE"`，没有 tooltip（悬停截图已确认）。
   - 按术语表保留 IDE，不做修改。
4. **P1：DOM 误翻用户/AI 内容**
   - 现在一律跳过以下内容：
     - 标签：PRE、CODE、TEXTAREA、INPUT
     - 可编辑区域：`contenteditable`（值不是 "false" 时）、`role=textbox`
     - 编辑器与终端：`.monaco-editor`、`.view-lines`、`.xterm`
     - 输入框：`ProseMirror`、`tiptap`
     - markdown 容器：`markdown-root`、`ui-markdown`、`rendered-markdown`
     - 聊天消息：`agent-transcript-row-markdown`、`agent-transcript-row-human`、`composer-human-message-content`
     - 消息属性：`data-message-role`、`data-message-kind`、`data-sent-message-bubble(-text)`、`data-agent-transcript-human-bubble`
   - MutationObserver 的增量路径同样按祖先链判断（流式输出不会被翻，有测试）。
   - 代价：Cursor 的模型选择器用 `ui-markdown` 渲染模型名，所以模型列表里的 “Default” 不再被 DOM 翻译（本来就算模型名）。
   - 设置页其余文案主要靠静态补丁，这次逐页扫描没有发现退化。

- `npm test`：40/40 通过（新增 5 条）。
- revert：4 个文件对照 deb 原版 sha256 全部 OK。localize 结果：经典 538 处，Agents 763 处，模板片段 24 处，NLS 163 条，0 条未命中，两个 bundle 都能通过 `node --check`。
- 截图：
  - `/workspace/shots/run3-agents.png`
  - `/workspace/shots/run3-classic.png`
  - `/workspace/shots/run3-classic-statusbar-hover.png`
  - `/workspace/shots/run3-agents-ide-hover.png`
  - `/workspace/shots/run3-agents-settings.png`
  - `/workspace/shots/run3-agents-settings-models.png`
- 设置页逐页扫描（Agents 窗口）还剩的英文（词典里没有，下一轮补）：
  - **外观**：Agent Conversations、Colors、High Contrast
  - **套餐与用量**：Included Usage、Resets、Upgrade to Pro（拼接串）
  - **智能体**：Cursor Default、“Control whether agents can read files outside the workspace…”、“Automatically parse links when pasted into Quick Edit…”
  - **源代码管理**：Pull Requests、“Mark Agent commits as 'Made with Cursor'”、worktree 清理的两条说明
  - **浏览器与网络**：Browser Tab、Network protocol、Show、Required domains、Network diagnostics
  - **代码智能**：“Accept the next word of a suggestion…”、“Automatically import necessary modules for TypeScript”、“Automatically index repositories…”、Codebase options、“Use with caution. Skip symlinks…”
  - **测试版**：Update Access、Updates

## 第 4 轮（2026-10-29，设置页补译 + 覆盖率扫描）

**新增 `scripts/coverage-scan.mjs`**：Cursor 需要临时用 `--remote-debugging-port=9333` 启动，然后运行
`node scripts/coverage-scan.mjs --json out.json --md out.md [--palette-pages N] [--only …]`。
脚本只做只读操作：
- 依次点击 Agents 窗口设置页和经典窗口 Cursor 设置页的各个导航项。会跳过带 ↗ 图标的外链项（云端智能体、文档），也跳过“返回”、VS Code 设置和账户入口，页面里的按钮一律不点。
- 打开 Agents 窗口标题栏菜单（文件/编辑/查看/帮助）。
- 在侧边栏条目上右键打开菜单。
- 读取命令面板最上面 N 屏（只看主标题，英文别名属于设计保留）。

菜单都用 Escape 关闭。每页统计“中文 / 英文 / 保留”三类节点，按 `scripts/coverage-keep.json`（依据术语表的保留英文：品牌、模型名、快捷键、日期、价格等）把保留项排除在外，再输出覆盖率和剩余英文清单。扫描结果在 `docs/coverage/3.27.22-run4-*.md`。

**本轮改动**
- 词典新增约 128 条，涵盖：
  - 设置页：外观、套餐与用量、智能体、源代码管理、浏览器与网络、代码智能、测试版，以及经典窗口特有的“智能体审查”“内联差异”等；
  - 资源管理器右键菜单；
  - 常用命令面板命令。
- `build-anchors.py` 新增两项：
  - `TEMPLATE_RULES`：对带 `${…}` 的模板和 JSX 数组拆分文案（如 `["Upgrade to ",u.name]`、`["Resets ",…]`、`` `…via ${u}` ``、`` `${X?"\u2318":"Ctrl+"}K` ``），按实际 bundle 文本生成 `{from,to,count}` 片段，变量名随版本变化时重跑一次即可；
  - 重新生成锚点时保留原有手写片段（前提是仍能精确匹配）。
- 本轮锚点数量：静态整段 388 / 429 条（desktop / glass），模板片段每个 bundle 27 条。
- 本轮 localize 结果：静态替换 1549 处，片段替换 74 处，NLS 176 条，未命中 0。
- DOM 运行时：命令面板（输入框以 `>` 开头时）的主标题可以按整段精确匹配翻译；英文别名（`quick-input-list-label-meta`）、Quick Open 文件名、资源管理器名字仍然不翻。新增对应测试，共 41 项。
- 关闭了第 2 轮扫描误点“云端智能体”时由 Cursor 拉起的 Chrome 窗口（cursor.com/dashboard/cloud-agents，17:08 打开）。

**覆盖率（扫描结果，前 → 后）**
- Agents 设置：
  - 外观 91.7 → 100%
  - 套餐与用量 28.6 → 100%
  - 智能体 96.5 → 100%
  - 语音 92.9 → 100%
  - 源代码管理 82.6 → 100%
  - 浏览器与网络 79.2 → 100%
  - 代码智能 82.8 → 100%
  - 测试版 60 → 100%
  - 常规、模型保持 100%
- 经典 Cursor 设置：
  - 常规 95.1 → 100%
  - 套餐与用量 28.6 → 100%
  - 智能体 75.4 → 100%
  - 源代码管理 57.6 → 100%
  - 浏览器与网络 77.3 → 100%
  - 代码智能 68 → 100%
  - 测试版 60 → 100%
  - 语音 92.9 → 100%
- 菜单：一直是 100%。
- 资源管理器右键菜单：78.6–80 → 100%。
- 命令面板：
  - 前 3 屏 28.1% → 前 2 屏 57.1%。剩下的 6 条都是 Cursor NDJSON Ingest / Deeplink 调试命令。
  - 前 12 屏 72.2%。剩下 37 条主要是 Developer:/Remote-SSH:/Merge Editor (Dev) 等开发者命令。
- “前”数据里命令面板那一行用的是旧选择器，把英文别名也算进去了，因此以 28.1% 为准。

**仍是英文（有意保留或暂不处理）**
- 套餐卡片里的“Pro $20/mo”和日期“Nov 26, 2026”：服务器下发的数据或日期格式。
- 语音页的 “submit”：语音提交口令。
- “Tab”“Cursor Tab”“LSP”“GitHub”：术语表规定保留。
- 命令面板里的开发者/调试命令。
- Agents 侧边栏当前没有智能体和仓库条目，所以右键菜单这次没有扫到内容；以后有条目时重跑脚本即可。
- 经典窗口的“自定义”页使用另一套布局，扫描结果是 0/0，需要单独处理。

## 第 5 轮（2026-10-29 17:30–18:00，Asia/Shanghai）：Linux 上真正可用的一键工具

- **提权**：新增 `helper/czl-apply.sh`（POSIX sh）和 `src/elevate.js`。
  - 提权顺序：pkexec → `sudo -n` → 给出手动 sudo 命令。
  - pkexec 和 sudo 都执行 `/bin/sh -c <脚本正文>`，授权后脚本无法被替换。
  - 如果存在 root 所有的 `/usr/lib/cursor-zh-localizer/czl-apply`（本工具 deb 安装），pkexec 改走它，配合 polkit 策略。
  - 等待授权的状态会记下来（pending），之后可以接着完成或取消。
- **box 的限制**：没有 polkitd，也没有 system dbus。pkexec 以 127 退出（"Error getting authority"），被正确识别为“无法完成授权”并回退，所以真正的 polkit 弹窗没能实测。实测了手动 sudo 命令和 `sudo -n` 两条路径。4 个文件始终保持 root:root。
- **关闭与重启 Cursor**：
  - 通过 /proc 识别主进程：没有 `--type=`，并且父进程不是 Cursor。Chromium 会把 cmdline 改写成一整串，需要拆回参数。
  - 用 SIGTERM 关闭，写完后按原 argv、cwd、环境重新打开。等待授权期间 Cursor 保持关闭，重启信息存在 relaunch.json。
- **AppImage**：识别只读挂载（squashfs、fuse、`/tmp/.mount_*`）。在独立 HOME 下实测了“解包 → 汉化（direct）→ 启动器”。rpm 的安装路径同 deb（`/usr/share/cursor`）。
- **GUI 端到端**：在 DISPLAY=:5 上用 xdotool 操作，截图在 `/workspace/shots/run5-*.png`。
  1. 状态显示“需要管理员权限”。
  2. 一键汉化 → 确认关闭 Cursor → 显示 sudo 命令。
  3. 执行命令后点“我已执行，继续”，Cursor 中文重启。
  4. 还原（`sudo -n`），Cursor 英文重启。
  5. 再次一键汉化（`sudo -n`），中文。
  6. 另外截了“汉化已失效”“暂未适配 9.9.9”“发现 AppImage”三种状态（用 `CZL_ROOT` 指向 /tmp 下的假安装，并使用独立 HOME）。
- **打包**：`scripts/build-desktop.mjs` 按仓库结构装配 `.build/app`，用 electron-builder 产出 `dist/*.AppImage` 和 `dist/*.deb`。
  - 打包后的 AppImage（`APPIMAGE_EXTRACT_AND_RUN=1`）实测：还原，然后汉化，都成功。
  - deb：`dpkg -i` 后从 `/usr/bin/cursor-zh-localizer` 启动正常；`czl-apply` 是 root 0755，拒绝 `../` 路径；`dpkg -r` 清理干净。

遗留：
- pkexec 加真实 polkit agent 的弹窗没有实测。
- 应用图标还是默认的 Electron 图标。
- deb 的 homepage 是占位地址。
- 路径里有空格时，Chromium cmdline 拆分可能出错。
- `dpkg --verify` 会报告 Cursor 的 4 个文件被改过。
- Windows 和 macOS 仍未支持。
