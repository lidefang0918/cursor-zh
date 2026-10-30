#!/bin/sh
# Tauri 版桌面程序打包（在 Linux 上）：Linux deb + AppImage，交叉编译 Windows NSIS 安装包 + 单文件便携 exe。
# macOS 版只能在 macOS 上构建：见 .github/workflows/tauri.yml，或在 Mac 上执行  cd apps/tauri && npx tauri build --target universal-apple-darwin --bundles app,dmg
# 依赖：rustup（stable + x86_64-pc-windows-msvc 目标）、cargo-xwin、clang/lld/llvm（llvm-rc）、nsis（makensis）、
#       libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev patchelf、npm 包 @tauri-apps/cli（npm install）
# 用法：sh scripts/build-tauri.sh [linux] [win]    默认两者都打；产物放 dist/（并复制到 $CZL_COPY_TO，默认 /workspace/dist）
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
COPY_TO=${CZL_COPY_TO-/workspace/dist}
VER=$(node -p "require('$REPO/apps/tauri/src-tauri/tauri.conf.json').version")
PRE="cursor-zh-$VER"
WHAT=${*:-linux win}
export PATH="$HOME/.cargo/bin:$PATH"
[ -d /usr/lib/llvm-19/bin ] && export PATH="$PATH:/usr/lib/llvm-19/bin"   # clang-cl
# 离线语言包：build.rs 依次找 $CZL_VSIX、vendor/、~/.config/cursor-zh-localizer/cache/
node "$REPO/scripts/sync-tauri-ui.mjs"
cd "$REPO/apps/tauri"
[ -x node_modules/.bin/tauri ] || [ -x "$REPO/node_modules/.bin/tauri" ] || (cd "$REPO" && npm install -w @cursor-zh/tauri)
T="$REPO/apps/tauri/src-tauri/target"
OUT="$REPO/dist"; mkdir -p "$OUT"
made=""
for w in $WHAT; do
  case $w in
    linux)
      npx tauri build --bundles deb,appimage
      cp "$T/release/bundle/deb/CursorZh_${VER}_amd64.deb" "$OUT/$PRE-linux-amd64.deb"
      cp "$T/release/bundle/appimage/CursorZh_${VER}_amd64.AppImage" "$OUT/$PRE-linux-x86_64.AppImage"
      made="$made $PRE-linux-amd64.deb $PRE-linux-x86_64.AppImage" ;;
    win)
      npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
      # Windows 上的产品名是中文（tauri.windows.conf.json）：开始菜单/桌面快捷方式、安装目录都叫“Cursor 一键汉化”
      cp "$T/x86_64-pc-windows-msvc/release/bundle/nsis/"*"_${VER}_x64-setup.exe" "$OUT/$PRE-win-x64-setup.exe"
      # 便携版就是程序本体：引擎、词典、语言包都嵌在 exe 里，首次运行解到 %LOCALAPPDATA%\local.cursor-zh-localizer.tauri\cache\engine\
      cp "$T/x86_64-pc-windows-msvc/release/cursor-zh.exe" "$OUT/$PRE-win-x64-portable.exe"
      made="$made $PRE-win-x64-setup.exe $PRE-win-x64-portable.exe" ;;
    *) echo "未知目标 $w（linux|win）" >&2; exit 2 ;;
  esac
done
# SHA256SUMS.txt：目录顶层所有产物（跳过 .sha256/.yml/.md 和子目录）
sums() {
  for f in *; do
    case $f in *.sha256|*.yml|*.md|SHA256SUMS.txt) continue ;; esac
    if [ -f "$f" ]; then sha256sum "$f"; fi
  done > SHA256SUMS.txt
}
cd "$OUT"
for f in $made; do sha256sum "$f" > "$f.sha256"; done
sums
if [ -n "$COPY_TO" ]; then
  mkdir -p "$COPY_TO"
  for f in $made; do cp "$f" "$f.sha256" "$COPY_TO/"; done
  (cd "$COPY_TO" && sums)
fi
for f in $made; do ls -l "$f"; cat "$f.sha256"; done
