#!/bin/sh
# 打一个只含 CLI 的离线包（不需要 npm install / Electron）：引擎、助手、锚点、词典、DOM 补漏、run.mjs、smoke-check.mjs、
# docs/mac-cli/RUN.md、pristine sha 列表，以及（如果本机缓存里有）中文语言包 vsix。
# 用法：sh scripts/pack-cli.sh [输出目录=/workspace/dist-mac-cli]   产物：<输出目录>/czl-cli.tar.gz
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-/workspace/dist-mac-cli}
S="$OUT/czl-cli"
rm -rf "$S" && mkdir -p "$S/scripts" "$S/packages/engine" "$S/vendor"
cd "$REPO"
cp -r anchors dicts "$S/"
cp -r packages/engine/src packages/engine/helper packages/engine/package.json "$S/packages/engine/"
cp -r packages/dom-runtime "$S/packages/"
cp scripts/run.mjs scripts/smoke-check.mjs "$S/scripts/"
cp docs/mac-cli/RUN.md docs/pristine-*.sha256 "$S/"
printf '{\n  "name": "cursor-zh-localizer",\n  "private": true,\n  "type": "module"\n}\n' > "$S/package.json"
for v in "${CZL_VSIX:-}" "$HOME/.config/cursor-zh-localizer/cache/ms-ceintl.vscode-language-pack-zh-hans-1.128.0.vsix"; do
  [ -n "$v" ] && [ -f "$v" ] && cp "$v" "$S/vendor/" && break
done
(cd "$OUT" && tar -czf czl-cli.tar.gz czl-cli && sha256sum czl-cli.tar.gz > czl-cli.tar.gz.sha256 && cat czl-cli.tar.gz.sha256)
