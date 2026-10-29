# Cursor 一键汉化 · Windows 测试指南

本工具目前是测试版，没有数字签名。只支持 Windows 10/11 x64。

## 1. 下载哪个文件

| 文件 | 说明 |
|---|---|
| `cursor-zh-localizer-0.1.0-win-x64-setup.exe` | **推荐**。这是安装包，装在当前用户下（`%LOCALAPPDATA%\Programs\cursor-zh-localizer`），不需要管理员权限。会创建开始菜单和桌面快捷方式「Cursor 一键汉化」，也可以在「设置 → 应用」里卸载。 |
| `cursor-zh-localizer-0.1.0-win-x64-portable.exe` | 便携版，双击就能运行，不用安装。每次启动都要先解压，所以会慢几秒。 |
| `cursor-zh-localizer-0.1.0-win-x64.zip` | 解压版。解压到任意目录后，运行 `cursor-zh-localizer.exe`。 |

三个文件里的程序完全一样，选一个就行。

## 2. 先确认 Cursor 版本

打开 Cursor，点菜单 **Help → About**（帮助 → 关于），看 Version：

- 已适配：**3.27.14**、**3.27.22**
- 其他版本：工具会显示「暂未适配」，不会改动任何文件。

Cursor 两种安装包都支持：

- 用户版（CursorUserSetup，装在 `%LOCALAPPDATA%\Programs\cursor`）
- 系统版（CursorSetup，装在 `C:\Program Files\cursor`，写入时需要 UAC）

## 3. 安装并运行

1. **先完全退出 Cursor**，包括所有窗口。如果没退出，工具会提示「Cursor 正在运行」，点「关闭 Cursor 并继续」也可以。
2. 双击 setup.exe（或便携版 exe）。
3. 可能会出现 SmartScreen 蓝色窗口「**Windows 已保护你的电脑**」。这是因为程序没有签名，按下面操作：
   1. 点「**更多信息**」。
   2. 点「**仍要运行**」。
   - 如果浏览器提示「不常下载」，选「保留」。
4. 安装向导：点「下一步」→「安装」→「完成」。安装完会自动启动工具，以后从开始菜单或桌面的「Cursor 一键汉化」打开。
5. 在工具窗口里，确认「安装」「版本」显示的是你的 Cursor，「版本」后面显示「已适配」，再点「**一键汉化**」。
6. 如果 Cursor 是**系统版**（Program Files），会弹出「**用户账户控制**」窗口：「你要允许此应用对你的设备进行更改吗？」程序是 Windows PowerShell，点「**是**」。
   - 用户版不会弹 UAC。
   - 如果点了「否」，工具会给出一条命令。这时右键开始菜单 →「终端(管理员)」，粘贴并执行这条命令，看到几行 `OK` 后，回到工具点「我已执行，继续」。
7. 显示「✔ 汉化完成」后，Cursor 会自动重新打开（或手动打开）。界面、菜单、设置页应为中文。
   - 第一次可能要再重启一次 Cursor，语言包才会生效。

## 4. 还原成英文

1. 打开工具，点「**一键还原**」。系统版同样会弹 UAC，点「是」。
2. 还原会做这些事：
   - 把安装目录的文件恢复成汉化前的原样（逐字节相同）
   - 卸载中文语言包
   - 恢复原来的界面语言设置

注意：**卸载本工具不会还原汉化**。想恢复英文，请先点「一键还原」，再卸载工具（「设置 → 应用 → Cursor 一键汉化 → 卸载」）。

Cursor 自动更新后，汉化会失效，界面会变回英文。只要新版本已适配，打开工具重新点「一键汉化」即可。

## 5. 日志和备份在哪

在资源管理器地址栏输入 `%APPDATA%\cursor-zh-localizer` 并回车，里面有这些文件：

| 路径 | 内容 |
|---|---|
| `gui.log` | 工具日志，包括每次操作和结果。**出问题时请发这个文件** |
| `state.json` | 当前汉化状态 |
| `backups\<版本号>\` | 汉化前原始文件的备份，还原就靠它 |
| `cursor-relaunch.log` | 重新打开 Cursor 的日志 |
| `elevate\` | UAC 写入时用的临时清单和脚本 |

另外，界面语言设置在 `%USERPROFILE%\.cursor\argv.json`（`"locale": "zh-cn"`），语言包在 `%USERPROFILE%\.cursor\extensions\ms-ceintl.vscode-language-pack-zh-hans-*`。

## 6. 测完请截图发回

1. 工具窗口：汉化前、汉化完成后，以及「一键还原」之后各一张（要能看到「安装」「版本」「状态」和下方日志）。
2. 如果出现 SmartScreen 或 UAC 窗口，各截一张。
3. Cursor 汉化后的画面：
   - 主窗口全景
   - 顶部菜单「文件 / 编辑 / 查看」展开
   - 设置页（Ctrl+,）
   - Agent 窗口及其菜单
   - 命令面板（Ctrl+Shift+P）
4. 还原后的 Cursor 主窗口，确认已经变回英文。
5. Cursor 的「Help → About」版本信息。
6. 出错时：错误提示截图，加上 `%APPDATA%\cursor-zh-localizer\gui.log` 文件。
