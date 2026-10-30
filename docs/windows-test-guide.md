# Cursor 一键汉化 · Windows 测试指南

本工具目前是测试版，没有数字签名。只支持 Windows 10/11 x64。

## 1. 下载哪个文件

现在有两套界面，功能、按钮、汉化结果完全一样，**优先测新版（Tauri）**：

| 文件 | 大小 | 说明 |
|---|---|---|
| `cursor-zh-localizer-0.1.0-tauri-win-x64-setup.exe` | 约 4 MB | **推荐**。新版安装包，装在当前用户下（`%LOCALAPPDATA%\Cursor 一键汉化`），不需要管理员权限。会创建开始菜单和桌面快捷方式「Cursor 一键汉化」，可在「设置 → 应用」里卸载。 |
| `cursor-zh-localizer-0.1.0-tauri-win-x64-portable.exe` | 约 4.5 MB | 新版便携版，单个 exe，双击就能运行。 |
| `cursor-zh-localizer-0.1.0-win-x64-setup.exe` | 约 80 MB | 旧版（Electron）安装包，新版有问题时再用。 |
| `cursor-zh-localizer-0.1.0-win-x64-portable.exe` | 约 80 MB | 旧版便携版。 |
| `cursor-zh-localizer-0.1.0-win-x64.zip` | | 旧版解压版，运行里面的 `cursor-zh-localizer.exe`。 |

新版为什么这么小：

- 界面用 Windows 自带的 **WebView2**（Win10/11 一般已经装好）。万一电脑上没有，安装包会自动下载安装它（需要联网）；便携版遇到这种情况会提示缺少 WebView2，这时改用安装包即可。
- 它不自带 Node，而是**借用你已安装的 Cursor.exe** 来运行汉化引擎（以 `ELECTRON_RUN_AS_NODE=1` 方式启动一个后台进程，不弹窗口）。Cursor.exe 本身**不会被修改**，只是被“借来跑一下”，跑完就退出。
- 汉化引擎和词典打包在 exe 里，第一次运行时解压到 `%LOCALAPPDATA%\local.cursor-zh-localizer.tauri\engine\`（约 10 MB，可随时删除，下次会重新解压）。

窗口里「状态」下面的日志第一行会显示「引擎运行环境：借用 Cursor 主程序 …」，请截图时带上这一行。

找不到 Cursor（例如装在非默认位置）时，窗口会出现「手动选择 Cursor 安装位置…」按钮，选中含 `Cursor.exe` 的文件夹即可。

## 2. 先确认 Cursor 版本

打开 Cursor，点菜单 **Help → About**（帮助 → 关于），看 Version：

- 已适配：**3.27.14**、**3.27.22**
- 其他版本：工具会显示「暂未适配」，不会改动任何文件。

Cursor 两种安装包都支持：

- 用户版（CursorUserSetup，装在 `%LOCALAPPDATA%\Programs\cursor`）
- 系统版（CursorSetup，装在 `C:\Program Files\cursor`，写入时需要 UAC）

## 3. 安装并运行

1. **先完全退出 Cursor**，包括所有窗口。如果没退出，工具会提示「Cursor 正在运行」，点「关闭 Cursor 并继续」也可以。
2. 双击 tauri-win-x64-setup.exe（或 tauri 便携版 exe）。
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

新版另外会在 `%LOCALAPPDATA%\local.cursor-zh-localizer.tauri\` 下放解压的引擎（`engine\`）和 WebView2 的界面缓存（`EBWebView\`），日志仍写在上面的 `gui.log`。

### 自检命令（可选）

在「命令提示符」里运行（安装版路径如下，便携版换成 exe 所在路径）：

```
"%LOCALAPPDATA%\Cursor 一键汉化\cursor-zh.exe" --self-test %TEMP%\st.json
notepad %TEMP%\st.json
```

不会打开窗口，也不改任何文件，只把检测到的 Cursor 安装、版本、运行环境写进 `st.json`。出问题时请把这个文件和 `gui.log` 一起发回。

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
