#!/bin/sh
# Windows 命令行包（zip，几 MB）：不带 Electron 界面，默认借用 Cursor.exe 自带的 Node 运行（ELECTRON_RUN_AS_NODE=1）。
# 设了 CZL_NODE_EXE=<node.exe> 时会把它放进 app\node\（启动脚本优先用它；包会大到 30MB 左右）。
# 用法：sh scripts/pack-win-cli.sh [输出目录=/workspace/dist]   产物：<输出目录>/cursor-zh-<版本>-win-x64-cli[-node].zip
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-/workspace/dist}
VER=$(node -p "require('$REPO/apps/desktop/package.json').version")
NAME=cursor-zh-$VER-win-x64-cli${CZL_NODE_EXE:+-node}
W=$(mktemp -d); S="$W/cursor-zh-win"; A="$S/app"
mkdir -p "$A/scripts" "$A/packages/engine" "$A/vendor" "$A/pristine"
cd "$REPO"
cp -r anchors dicts "$A/"
cp -r packages/engine/src packages/engine/helper packages/engine/package.json "$A/packages/engine/"
rm -f "$A/packages/engine/helper/czl-apply.sh"
cp -r packages/dom-runtime "$A/packages/"
cp scripts/run.mjs "$A/scripts/"
cp docs/pristine-*-win32-*.sha256 "$A/pristine/"
printf '{\n  "name": "cursor-zh",\n  "version": "%s",\n  "private": true,\n  "type": "module"\n}\n' "$VER" > "$A/package.json"
V=ms-ceintl.vscode-language-pack-zh-hans-1.128.0.vsix
for v in "${CZL_VSIX:-}" "$REPO/vendor/$V" "$HOME/.config/cursor-zh-localizer/cache/$V"; do
  [ -n "$v" ] && [ -f "$v" ] && cp "$v" "$A/vendor/$V" && break
done
[ -f "$A/vendor/$V" ] || { echo "缺少语言包 $V" >&2; exit 1; }
if [ -n "${CZL_NODE_EXE:-}" ]; then mkdir -p "$A/node" && cp "$CZL_NODE_EXE" "$A/node/node.exe"; fi
P=packaging/win-cli
cp "$P/czl.cmd" "$A/czl.cmd"
cp "$P/localize.bat" "$S/一键汉化.bat"
cp "$P/revert.bat" "$S/一键还原.bat"
cp "$P/status.bat" "$S/查看状态.bat"
cp "$P/readme.txt" "$S/使用说明.txt"
mkdir -p "$OUT"; rm -f "$OUT/$NAME.zip"
SEVENZ=${SEVENZIP:-$REPO/../tools/7zz}
# 普通 Deflate（资源管理器能直接打开），-mcu=on：文件名按 UTF-8 存并置标志位，中文名不乱码
(cd "$W" && "$SEVENZ" a -tzip -mm=Deflate -mx=9 -mfb=258 -mpass=15 -mcu=on -bso0 "$OUT/$NAME.zip" cursor-zh-win)
rm -rf "$W"
(cd "$OUT" && sha256sum "$NAME.zip" | tee "$NAME.zip.sha256" && ls -l "$NAME.zip")
