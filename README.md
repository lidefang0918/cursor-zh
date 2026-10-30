# cursor-zh

**Cursor 一键汉化**：把 Cursor 的菜单、设置、命令面板、Agent / Chat、智能体窗口换成简体中文，随时一键还原成英文原版。

- 基于微软官方简体中文语言包，加上静态补丁和运行时补漏，覆盖 Cursor 自己的界面文字
- 修改前自动备份，还原后与原版逐字节相同；不读取、不修改登录信息、聊天记录和项目文件
- 图形界面用系统自带的网页组件（Tauri），安装包只有几 MB；汉化引擎借用你已安装的 Cursor 主程序运行
- 支持 Windows 10/11 x64、macOS（Apple 芯片 / Intel 通用）、Linux（deb / rpm / AppImage）

> 本工具与 Cursor 官方无关。

## 下载

👉 **[GitHub Releases 下载最新版](https://github.com/lidefang0918/cursor-zh/releases)**

| 系统 | 文件 |
|---|---|
| Windows | `cursor-zh-<版本>-win-x64-setup.exe`（安装版，推荐）/ `-win-x64-portable.exe`（免安装）/ `-win-x64-cli.zip`（命令行精简版） |
| macOS | `cursor-zh-<版本>-mac-universal.dmg` / `.app.zip`（未经 Apple 公证，首次打开请右键 → 打开） |
| Linux | `cursor-zh-<版本>-linux-amd64.deb` / `-linux-x86_64.AppImage` |

用法：先关闭 Cursor（或让工具代为关闭）→ 打开“Cursor 一键汉化”→ 点 **一键汉化**。想换回英文点 **一键还原**。Cursor 自动更新后汉化会失效，重新点一次即可。

详细说明见 **[docs/使用说明.md](docs/使用说明.md)**。

## 关于名字

项目原名 `cursor-zh-localizer`，现已改名为 `cursor-zh`。为了让已经汉化过的用户能正常还原和升级，下列**运行时标识保持旧名不变**：

- 数据目录（备份、状态、日志）：`%APPDATA%\cursor-zh-localizer`、`~/Library/Application Support/cursor-zh-localizer`、`~/.config/cursor-zh-localizer`
- 桌面版应用标识 `local.cursor-zh-localizer.tauri`（决定缓存目录、Windows 安装注册表项、macOS Bundle ID，改了会变成另一个“应用”而无法覆盖升级）
- Linux 提权助手 `/usr/lib/cursor-zh-localizer/czl-apply` 与 polkit 动作 `local.cursor-zh-localizer.apply`
- Cursor 文件里的补丁标记、DOM 注入脚本标识，以及 `CZL_*` 环境变量、`czl-` 前缀的临时文件

## 开发者说明

### 命令行与行为（Linux）

- 图形界面：安装 `cursor-zh-<ver>-linux-amd64.deb`，或直接运行 `cursor-zh-<ver>-linux-x86_64.AppImage`（没有 FUSE 时加环境变量 `APPIMAGE_EXTRACT_AND_RUN=1`）。
- 命令行：`node scripts/run.mjs status|localize|revert [--close] [--no-relaunch] [--elevate=pkexec,sudo-n,manual] [--root=<安装目录>]`；`node scripts/run.mjs extract-appimage <Cursor.AppImage>`。

行为说明：

- **Cursor 正在运行**：先询问；同意后正常关闭 Cursor（SIGTERM，最多等 20 秒），写完后按原来的命令行、工作目录和环境重新打开。
- **安装目录归 root（deb/rpm 的 `/usr/share/cursor`）**：界面始终以普通用户运行。备份和打补丁都在 `~/.config/cursor-zh-localizer` 里完成，只有“把准备好的文件放进安装目录”这一步交给 `packages/engine/helper/czl-apply.sh`，以 root 运行。这个脚本只认白名单路径，逐个校验 sha256，原子替换，并保留属主和权限。
  - 提权顺序：pkexec（图形授权弹窗）→ 免密 `sudo -n` → 给出一条终端命令，例如 `sudo sh '~/.config/cursor-zh-localizer/elevate/czl-apply.sh' '.../apply.tsv'`。
  - 执行这条命令后点“我已执行，继续”。也可以直接再点“一键汉化”或再运行一次 `localize`，会自动接着完成。
  - 用环境变量 `CZL_ELEVATE` 可以改变提权顺序。
- **用本工具的 .deb 安装时**：postinst 会把 helper 装到 `/usr/lib/cursor-zh-localizer/czl-apply`（归 root），并装上 polkit 策略 `local.cursor-zh-localizer.apply`，授权弹窗会显示中文说明。
- **AppImage 版 Cursor**：AppImage 是只读的 squashfs，无法原地修改。可以用“解包并汉化”，解包到 `~/.local/share/cursor-zh-localizer/cursor-appimage/<ver>`，并创建启动器“Cursor（中文）”和命令 `~/.local/bin/cursor-zh`。解包副本不会随 AppImage 自动更新。
- **apt/rpm 升级 Cursor 后**：汉化会被覆盖，界面显示“汉化已失效”，重新点“一键汉化”即可。

### Windows / macOS

> Windows 已在真机上验证汉化 / 还原；macOS 已在真机（Apple 芯片）上验证。真机测试计划见 `docs/real-machine-test-plan.md`。

- **Windows**：用户级安装（`%LOCALAPPDATA%\Programs\cursor`）直接写入；系统级安装（`C:\Program Files\cursor`）会弹 UAC，点“是”后由内嵌的 `czl-apply.ps1` 写入（白名单 + sha256 校验 + 原子替换）。拒绝 UAC 时会给出一条在管理员 PowerShell 里执行的命令。product.json 只改 checksum，`target` 等其余内容保持原样。
- **macOS**：
  - 改 `Cursor.app` 里的文件会让官方签名失效，所以默认（`--mac-sign=adhoc`）改完后对外层做一次 ad-hoc 重签名并去掉 quarantine；`adhoc-deep` 整包重签（先 APFS clone 备份，只支持直接可写的情况）；`none` 不重签。还原时连同签名文件一起恢复，签名回到官方 Developer ID。
  - macOS 13+ 的“App 管理”权限会拦截修改，按提示到 系统设置 → 隐私与安全性 → App 管理 里给本工具（或终端）打开开关。
  - 直接在“下载”里打开的 Cursor 会被系统转移到只读的随机路径（App Translocation），请先把 Cursor 移到“应用程序”。
  - 汉化后首次启动可能弹出“Cursor Safe Storage”钥匙串提示，选“始终允许”。ad-hoc 签名后 Cursor 自带的自动更新可能失败：**更新 Cursor 前先“一键还原”**，更新完再汉化。
- 命令行：`node scripts/run.mjs localize [--close] [--root=<安装根>] [--mac-sign=adhoc|adhoc-deep|none]`。macOS 的安装根是 `.../Cursor.app/Contents`。
- 冒烟检查（只读）：`node scripts/smoke-check.mjs pristine|patched|checksums <安装根> <linux|win32|darwin>`、`node scripts/smoke-check.mjs ui <调试端口>`；CI 草稿：`.github/workflows/platform-smoke.yml`。

### 开发

- 新版本 Cursor 适配：`sh scripts/new-version.sh [版本号|latest] [--all-platforms]`（下载官方包 → 生成锚点 → 全流程校验 → 测试，打印缺失词条和下一步）；CI 草稿 `.github/workflows/ci.yml` 每周自动检查一次
- 术语一致性：`node scripts/check-glossary.mjs`（也在 `npm test` 里）

- `npm test`
- Tauri 桌面版打包（Linux 上出 Linux + Windows）：`sh scripts/build-tauri.sh [linux] [win]`；Windows 命令行精简版：`sh scripts/pack-win-cli.sh`；macOS：在 Mac 上 `cd apps/tauri && npx tauri build --target universal-apple-darwin --bundles app,dmg`，或运行 Actions 里的 `tauri` 工作流
- 旧版 Electron 界面（备用）：`cd apps/desktop && npx electron .`（指定安装目录：`CZL_ROOT=<dir>`）
- Electron 备用版打包：`node scripts/build-desktop.mjs [--appimage|--deb|--win|--mac]`，产物 `dist/cursor-zh-electron-*`（win/mac 在 Linux 上交叉打包；mac 包需要 `rcodesign` 和 `zip`/`7zz` 才会做 ad-hoc 签名）
- 官方安装包离线验证：`node scripts/verify-platform-trees.mjs <名字>=<platform>:<安装根> ...`
