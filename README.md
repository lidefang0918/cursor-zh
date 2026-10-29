# cursor-zh-localizer

Cursor 一键汉化工具（Electron GUI + Node 引擎：微软官方简体语言包 + 静态补丁 + DOM 补漏）。

> ⚠️ 开发与验证只在 box（Grok Bot 的 Linux 机器）上进行，只修改 box 上安装的 Cursor；绝不修改用户自己电脑上的 Cursor。本工具会改动 Cursor 安装目录，改动前强制备份，可一键还原；与 Cursor 官方无关。

## 使用（Linux）

- 图形界面：安装 `dist/cursor-zh-localizer-<ver>-amd64.deb`，或直接运行 `dist/cursor-zh-localizer-<ver>-x86_64.AppImage`（没有 FUSE 时加环境变量 `APPIMAGE_EXTRACT_AND_RUN=1`）。打开后点“一键汉化”/“一键还原”。
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

## 开发

- `npm test`
- GUI：`cd apps/desktop && npx electron .`（指定安装目录：`CZL_ROOT=<dir>`）
- 打包：`node scripts/build-desktop.mjs [--appimage|--deb]`，产物在 `dist/`
