# Cursor 汉化 CLI：macOS 真机验证（Cursor 3.27.14，arm64）

不需要 npm install。引擎没有任何依赖，只用 Node 内置模块，Node 18 及以上就能跑（已在 v24 上测试）。
语言包 vsix 已经放在 `vendor/` 里，汉化时不需要联网。

## 改动范围

- **会改的**：
  - `/Applications/Cursor.app` 里的文件：
    - `Resources/app/out/vs/workbench/workbench.{desktop,glass}.main.js`
    - `Resources/app/out/nls.messages.json`
    - `Resources/app/product.json`
    - ad-hoc 重签名会改动 `MacOS/Cursor` 和 `_CodeSignature/CodeResources`
  - `~/.cursor/argv.json`：加上 `"locale": "zh-cn"`
  - `~/.cursor/extensions`：装中文语言包
  - `~/Library/Application Support/Cursor/clp`：清掉 NLS 缓存
- **备份和状态**：`~/Library/Application Support/cursor-zh-localizer/`
- **不会碰的**：其他任何 App，包括 Grok Bot 桌面版。所有命令都用 `--root` 指定只操作 `/Applications/Cursor.app`。进程匹配只认 `/Applications/Cursor.app/Contents/` 下的可执行文件。
- 登录信息（user-data 里的认证数据、钥匙串条目）都不会读，也不会改。

## 0. 准备

```sh
# 不要在 Cursor 自带的终端里执行（汉化时 Cursor 必须退出），请用“终端.app”或 iTerm
source ~/.nvm/nvm.sh            # 让 node 可用（node -v 应显示 v24.x）
mkdir -p ~/czl && tar -xzf ~/Downloads/czl-cli.tar.gz -C ~/czl && cd ~/czl/czl-cli
ROOT=/Applications/Cursor.app/Contents
```

## 1. 汉化前：确认是官方原版

```sh
(cd "$ROOT/Resources/app" && shasum -a 256 -c ~/czl/czl-cli/pristine-3.27.14-darwin-arm64.sha256)
codesign --verify --deep --strict --verbose=2 /Applications/Cursor.app
codesign -dv /Applications/Cursor.app 2>&1 | grep -E 'TeamIdentifier|Signature'
node scripts/run.mjs status --root="$ROOT"
```

预期结果：
- 4 个文件都显示 `OK`。
- codesign 显示 `valid on disk`，以及 `TeamIdentifier=VDXQ22DGB9`。
- status 输出里 `version` 是 3.27.14，`"supported": true`，`"kind": "mac-applications"`。

如果 status 显示 3.27.22，说明 Cursor 在退出时自动更新了。这个版本同样支持，但上面的 sha 文件就对不上了。

## 2. 汉化

先按 ⌘Q 完全退出 Cursor（推荐）。然后执行：

```sh
node scripts/run.mjs localize --root="$ROOT" --mac-sign=adhoc
```

- `--mac-sign` 默认就是 `adhoc`，可以不写。
- 如果 Cursor 还开着，命令会返回 `"code": "CURSOR_RUNNING"`，什么都不改。也可以加 `--close`：工具会正常关闭 Cursor（SIGTERM，最多等 20 秒），写完后用 `open /Applications/Cursor.app` 重新打开。加 `--no-relaunch` 则写完后不重新打开。
- 如果返回 `"code": "MAC_APP_MANAGEMENT"`，说明 macOS 的“App 管理”权限拦住了。打开 系统设置 → 隐私与安全性 → App 管理，给“终端”打开开关，然后**完全退出并重开终端**，再执行一次 localize。
- 成功时输出 `"ok": true`，日志里会有“静态补丁：替换 1549 处，模板片段 74 处；未命中 0 条”和“NLS 文案：替换 176 条”。

## 3. 汉化后检查

```sh
node scripts/smoke-check.mjs patched   "$ROOT" darwin
node scripts/smoke-check.mjs checksums "$ROOT" darwin
codesign --verify --deep --strict --verbose=2 /Applications/Cursor.app
codesign -dv /Applications/Cursor.app 2>&1 | grep -E 'Signature=adhoc'
open /Applications/Cursor.app
```

- 打开 Cursor 后，界面应该是中文，并且**不出现**“安装似乎已损坏”的提示。
- 如果弹出“Cursor 想要访问钥匙串中的 Cursor Safe Storage”，输入登录密码，然后选“始终允许”，否则可能需要重新登录。
- 可选的界面自动检查：用一个临时的独立配置另开一个实例，不影响正在用的 Cursor：

  ```sh
  "$ROOT/MacOS/Cursor" --user-data-dir=/tmp/czl-ui --remote-debugging-port=9444 >/dev/null 2>&1 &
  node scripts/smoke-check.mjs ui 9444 90
  pkill -f -- '--user-data-dir=/tmp/czl-ui'; rm -rf /tmp/czl-ui
  ```

## 4. 还原

先 ⌘Q 退出 Cursor（或加 `--close`），然后执行：

```sh
node scripts/run.mjs revert --root="$ROOT"
(cd "$ROOT/Resources/app" && shasum -a 256 -c ~/czl/czl-cli/pristine-3.27.14-darwin-arm64.sha256)
node scripts/smoke-check.mjs pristine "$ROOT" darwin
codesign --verify --deep --strict --verbose=2 /Applications/Cursor.app
codesign -dv /Applications/Cursor.app 2>&1 | grep TeamIdentifier=VDXQ22DGB9
```

还原后，4 个文件逐字节回到原版，签名回到官方 Developer ID。语言包会被卸载，locale 恢复成原来的值。

## 注意

- 汉化（ad-hoc 签名）期间，Cursor 的自动更新可能失败。**更新 Cursor 前先还原**，更新后再汉化。
- 每一步的 JSON 输出都请保存下来，用于反馈：`node scripts/run.mjs … | tee -a ~/czl/run.log`。
