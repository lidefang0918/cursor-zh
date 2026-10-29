#!/usr/bin/env bash
# box 专用：box 重启后 /usr/share/cursor 会被清掉，用这个脚本把 Cursor 3.27.22（Linux x64 deb）原样装回去。
# 只在 Grok Bot 的 box 上用，不要在用户自己的电脑上跑。
# 安装包缓存在 /workspace/cache（重启后保留），sha256 来自官方 apt 源的 Packages 索引。
set -euo pipefail
VER=3.27.22
URL="https://downloads.cursor.com/aptrepo/pool/stable/c/cu/cursor_${VER}_amd64.deb"
SHA256=863a9dd15ca5fe84dd2f8e74fe2e926e8b438692f202277a89dd0ec3d928bf98
CACHE=/workspace/cache
DEB="$CACHE/cursor_${VER}_amd64.deb"
mkdir -p "$CACHE"
if ! echo "$SHA256  $DEB" | sha256sum -c --status 2>/dev/null; then
  echo "下载 $URL"
  curl -fL --retry 3 -o "$DEB.part" "$URL"
  echo "$SHA256  $DEB.part" | sha256sum -c -
  mv "$DEB.part" "$DEB"
fi
echo "安装 $DEB"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$DEB"
python3 -c "import json;p=json.load(open('/usr/share/cursor/resources/app/product.json'));print('Cursor',p.get('version'),p.get('commit'),'vscode',p.get('vscodeVersion'))"
# box 专用的权限绕过：让 box 用户能写汉化要改的文件（真实用户走提权流程）
if [[ "${1:-}" == "--chown" ]]; then
  A=/usr/share/cursor/resources/app
  sudo chown box:box "$A/product.json" "$A/out/nls.messages.json" "$A/out/vs/workbench/workbench.desktop.main.js" "$A/out/vs/workbench/workbench.glass.main.js"
  echo "已 chown box:box 汉化目标文件"
fi
