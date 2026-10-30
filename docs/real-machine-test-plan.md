# 真机测试计划：Windows / macOS（Cursor 3.27.22）

box 是 Linux，Windows / macOS 的代码只用假安装树、模拟命令和官方安装包解出的文件做过离线验证（见 `docs/box-validation-notes.md` 第 6 轮）。
下面这些只能在真机上确认。每一项都写了操作步骤和预期结果。CI 能覆盖的部分见 `.github/workflows/platform-smoke.yml`（草稿）。

**准备**
- 用一台可以随便折腾的测试机或虚拟机，不要用日常工作的机器。
- 装官方 3.27.22，sha256 见 `docs/box-validation-notes.md`。
- 先登录或备份好 Cursor 的设置。
- 每项测完都执行一次“还原”，再用 `node scripts/smoke-check.mjs pristine <安装根> <win32|darwin>` 确认文件已逐字节回到原版。

## 通用（两个平台都要测）

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| G1 | 检测 | 打开 GUI，或执行 `node scripts/run.mjs status` | 识别出安装目录、版本 3.27.22、`supported: true`，`kind` 对应正确 |
| G2 | 汉化 | Cursor 已关闭时点“一键汉化” | 成功。重新打开 Cursor 后菜单、设置、Agent 面板都是中文，**没有“安装似乎已损坏”提示** |
| G3 | Cursor 正在运行 | Cursor 开着时点汉化 → “关闭 Cursor 并继续” | Cursor 正常退出（macOS 不弹出「意外退出」崩溃报告；未保存的内容会被 hot-exit 保留），写完后自动重新打开，原来的窗口和工作区都恢复 |
| G4 | 还原 | 点“一键还原” | 界面回到英文；`smoke-check pristine` 通过；Windows 上 product.json 的 `target` 字段保持不变 |
| G5 | 再次汉化 / 更新 | 用 Cursor 自带的更新升级到新版本 | 新版本没有锚点时显示“不支持的版本”，不会去改文件；状态显示“汉化已失效” |
| G6 | 登录态 | 已登录的 Cursor 汉化后再还原 | 账号仍是登录状态（本工具不碰 user-data 里的认证数据） |
| G7 | 被别的工具改过 | 先手动改一个字节的 workbench.desktop.main.js，再汉化 | 报 `MODIFIED_INSTALL`，什么都不改 |

## Windows

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| W1 | 用户级安装（CursorUserSetup） | 安装在 `%LOCALAPPDATA%\Programs\cursor` | `kind: win-user`，直接写入，不弹 UAC |
| W2 | 系统级安装（CursorSetup） | 安装在 `C:\Program Files\cursor`，用**普通用户**运行本工具 | 弹出 UAC，标题是 Windows PowerShell。点“是”后写入成功，`method: uac` |
| W3 | UAC 点“否” | 同 W2，点“否” | 不报错崩溃，界面给出一条手动命令（`powershell -NoProfile -ExecutionPolicy Bypass -File "...czl-apply.ps1" -Manifest "..."`）。在管理员 PowerShell 里执行后点“我已执行，继续”，汉化完成 |
| W4 | 在注册表里检测 | 装到自定义目录，例如 `D:\Apps\cursor` | 从 `HKCU/HKLM\...\Uninstall` 的 InstallLocation 找到，`kind: win-other` |
| W5 | 文件被占用 | 让 Cursor 的某个子进程（例如残留的 extension host）一直占着文件 | 写入会重试，最终要么成功，要么报清楚的错误并回滚；不能出现一半新一半旧 |
| W6 | 进程识别 | 同时开着 VS Code 和另一份 Cursor | 只关闭目标安装的 Cursor.exe（按 ExecutablePath 比对，不区分大小写），别的不动 |
| W7 | 关闭 / 重启 | G3 | taskkill /PID 优雅关闭；20 秒内没退出才 /T /F；重新打开的是同一个 Cursor.exe |
| W8 | 路径里有空格或中文 | 用户名是中文，或者把本工具放在 `D:\我的 工具\` | 正常工作（这是 fileURLToPath 修复针对的场景） |
| W9 | 杀毒软件 / SmartScreen | Defender 开着时运行便携版 exe | 记录 SmartScreen 提示（未签名，属于预期）；Defender 不能拦截或删除 `.czl-new` 临时文件 |
| W10 | 语言包 | 汉化后看 `%USERPROFILE%\.cursor\extensions` 和 `argv.json` | 中文语言包已安装，`"locale": "zh-cn"`；还原后语言包被卸载、locale 恢复原值 |
| W11 | 打包产物 | 运行 `cursor-zh-0.1.0-win-x64-portable.exe` 和 `-setup.exe` | 能启动，界面完整；在 Program Files 场景下 UAC 流程同 W2 |

## macOS

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| M1 | /Applications 安装（管理员用户） | dmg 拖进 /Applications，用 GUI 汉化 | 直接写入。随后对外层做 ad-hoc 重签名并去掉 quarantine。`codesign --verify --deep --strict` 通过，Cursor 正常启动，显示中文 |
| M2 | “App 管理”权限（macOS 13+） | 没给本工具或终端“App 管理”权限时汉化 | 报 `MAC_APP_MANAGEMENT`，提示去 系统设置 → 隐私与安全性 → App 管理 打开开关。授权后点“我已处理，重试”成功。**需要确认**：EPERM 是否确实在 open 探测时就出现，还是只在写入时才出现 |
| M3 | 非管理员用户 / 目录不可写 | /Applications/Cursor.app 属于别的用户 | 弹 osascript 管理员授权框，输入密码后成功（`method: osascript`）；点“取消”后给出 `sudo sh ... apply.tsv` 手动命令 |
| M4 | App Translocation | 下载后直接在“下载”文件夹里打开 Cursor.app（不移动），再运行本工具 | 报 `MAC_TRANSLOCATED`，提示先把 Cursor 移到“应用程序” |
| M5 | 钥匙串 | 汉化后第一次启动 | 可能弹“Cursor 想要访问钥匙串中的 Cursor Safe Storage”，点“始终允许”后登录态保持；记录实际是否弹出 |
| M6 | 自动更新 | 汉化后（ad-hoc 签名）检查更新 | 记录 Squirrel 更新是否会因签名不符失败。预期会失败或需要先还原；README 已写明“更新前先还原” |
| M7 | 还原后签名 | G4 | `codesign -dv` 显示 `TeamIdentifier=VDXQ22DGB9`，`spctl -a -vv` 显示 accepted / Notarized Developer ID |
| M8 | macSign=none | `--mac-sign=none` | 不重签名。记录 Cursor 是否还能启动（Apple Silicon 上预期能启动，因为只改了资源文件，可执行文件签名没动；但 `codesign --verify` 会失败） |
| M9 | macSign=adhoc-deep | `--mac-sign=adhoc-deep`，Cursor.app 需要直接可写 | 先在 APFS 上 clone 一份备份，再做整包 ad-hoc 签名。还原时把整个 .app 换回去，签名回到 Developer ID |
| M10 | Intel 与 Apple Silicon | 分别在 x64 和 arm64 机器上跑 M1 / M7 | 都通过 |
| M11 | 进程识别 / 关闭 | Cursor 开着时汉化 | `ps` 只匹配 `<root>/MacOS/Cursor` 和它的 Helper（忽略 engine-ipc）；osascript AppleEvent 退出（等同 ⌘Q，不 SIGTERM），进程全部消失后再写入/重签，用 `open <app>` 重新打开；不应出现「Cursor 意外退出」 |
| M12 | 打包产物 | 打开 `cursor-zh-0.1.0-mac-universal.dmg`，拖到“应用程序”，右键 → 打开 | 能启动（已 ad-hoc 签名，未公证，首次打开 Gatekeeper 会提示）；在 Apple Silicon 上不能提示“已损坏” |

## 结果记录模板

```
机器：Windows 11 23H2 / macOS 15.x（arm64）   用户类型：管理员 / 标准
Cursor：3.27.22 user-setup / system-setup / dmg   安装根：...
编号  结果(通过/失败/不适用)  备注（截图、GUI 日志或 run.mjs 的 JSON 输出，以及数据目录里的 state.json：%APPDATA%\cursor-zh-localizer 或 ~/Library/Application Support/cursor-zh-localizer）
```
