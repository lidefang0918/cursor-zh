#!/bin/sh
# Cursor 出新版本时的一条命令流程（只在 box / CI 上跑，不碰任何用户电脑）：
#   下载官方 .deb → 解包 → 生成锚点 anchors/<版本>.json → （可选）下载 Windows/macOS 官方包核对文件一致
#   → verify-platform-trees 全流程校验 → npm test → 打印 MISSING 词条和下一步。
# 用法：sh scripts/new-version.sh [版本号|latest] [--all-platforms]
#   CZL_CACHE=缓存目录（默认 /workspace/cache/v）  CZL_7ZZ / CZL_INNOEXTRACT=工具路径
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
V=${1:-latest}
ALL=0; [ "${2:-}" = "--all-platforms" ] || [ "${1:-}" = "--all-platforms" ] && ALL=1
[ "$V" = "--all-platforms" ] && V=latest
CACHE=${CZL_CACHE:-/workspace/cache/v}
Z7=${CZL_7ZZ:-$(command -v 7zz || echo /workspace/tools/7zz)}
INNO=${CZL_INNOEXTRACT:-$(command -v innoextract || echo /workspace/tools/innoextract-1.9-linux/innoextract)}
say() { printf '· %s\n' "$*"; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }
get() { [ -s "$2" ] || { say "下载 $1"; curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }; }

api() { curl -fsL "https://cursor.com/api/download?platform=$1&releaseTrack=stable" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j[process.argv[1]])})' "$2"; }
LATEST=$(api linux-x64 version) || die "取不到最新版本号（网络？）"
[ "$V" = latest ] && V=$LATEST
D="$CACHE/$V"; mkdir -p "$D"
say "Cursor $V，缓存目录 $D"

get "https://downloads.cursor.com/aptrepo/pool/stable/c/cu/cursor_${V}_amd64.deb" "$D/cursor.deb" || die "下载 .deb 失败（版本号对吗？）"
LROOT="$D/linux/usr/share/cursor"
[ -d "$LROOT" ] || { rm -rf "$D/linux"; dpkg-deb -x "$D/cursor.deb" "$D/linux"; }
COMMIT=$(node -e 'console.log(require(process.argv[1]).commit)' "$LROOT/resources/app/product.json")
say "commit $COMMIT"

if [ -f "$REPO/anchors/$V.json" ]; then say "anchors/$V.json 已存在，将按新词典重新生成"; fi
python3 "$REPO/scripts/build-anchors.py" "$LROOT" > "$D/anchors-report.txt" 2>&1 || { cat "$D/anchors-report.txt"; die "生成锚点失败"; }
tail -1 "$D/anchors-report.txt"

SPECS="linux=linux:$LROOT"
if [ "$ALL" = 1 ]; then
  # 下载路径里的 hash 和 product.json 的 commit 不一定相同，所以 Windows/macOS 地址从官方下载接口取；
  # 旧版本接口查不到，需要用 CZL_BASE=https://downloads.cursor.com/production/<hash> 指定
  if [ -n "${CZL_BASE:-}" ]; then WURL="$CZL_BASE/win32/x64/user-setup/CursorUserSetup-x64-$V.exe"; MURL="$CZL_BASE/darwin/universal/Cursor-darwin-universal.zip"
  elif [ "$V" = "$LATEST" ]; then WURL=$(api win32-x64-user downloadUrl); MURL=$(api darwin-universal downloadUrl | sed 's/\.dmg$/.zip/')
  else die "$V 不是最新版，接口查不到 Windows/macOS 下载地址；请设置 CZL_BASE，或去掉 --all-platforms"; fi
  get "$MURL" "$D/mac-universal.zip"
  [ -d "$D/mac/Cursor.app" ] || { rm -rf "$D/mac"; "$Z7" x -snl -y -o"$D/mac" "$D/mac-universal.zip" >/dev/null; }
  MROOT="$D/mac/Cursor.app/Contents"
  SPECS="$SPECS mac=darwin:$MROOT"
  get "$WURL" "$D/win-user.exe"
  WROOT="$D/win/app"
  if [ ! -d "$WROOT/resources" ]; then
    rm -rf "$D/win"
    # innoextract 1.9（Ubuntu 自带）还不认识 Inno Setup 6.4；解不开就跳过 Windows 核对，由 platform-smoke 工作流在 Windows 机器上验证
    "$INNO" -s -d "$D/win" "$D/win-user.exe" >/dev/null 2>&1 || say "⚠ 本机 innoextract 解不开 Windows 安装包，跳过 Windows 核对"
  fi
  for f in out/vs/workbench/workbench.desktop.main.js out/vs/workbench/workbench.glass.main.js out/nls.messages.json; do
    a=$(sha256sum "$LROOT/resources/app/$f" | cut -c1-64)
    m=$(sha256sum "$MROOT/Resources/app/$f" | cut -c1-64)
    [ "$a" = "$m" ] && say "Linux / macOS 一致：$f" || say "⚠ macOS 与 Linux 不同：$f（需要 --platform darwin 单独生成锚点）"
    if [ -f "$WROOT/resources/app/$f" ]; then
      w=$(sha256sum "$WROOT/resources/app/$f" | cut -c1-64)
      [ "$a" = "$w" ] && say "Linux / Windows 一致：$f" || say "⚠ Windows 与 Linux 不同：$f（需要 --platform win32 单独生成锚点）"
    fi
  done
  [ -d "$WROOT/resources" ] && SPECS="$SPECS win=win32:$WROOT"
fi

# shellcheck disable=SC2086
node "$REPO/scripts/verify-platform-trees.mjs" $SPECS > "$D/verify.log" 2>&1 && say "全流程校验通过（$D/verify.log）" || { tail -20 "$D/verify.log"; die "全流程校验未通过"; }
(cd "$REPO" && npm test --silent > "$D/test.log" 2>&1) && say "npm test 通过" || { tail -30 "$D/test.log"; die "npm test 未通过"; }

# 两个 bundle 里都找不到的词条（只在一个 bundle 里出现是正常的）
sed -n "s/^\(SAFE\|UNSAFE\|MISSING\) *[^ ]* *n=[0-9]* *[\"']\(.*\)[\"'] \[.*/\1\t\2/p" "$D/anchors-report.txt" | sort -u > "$D/anchors-tsv.txt"
cut -f2 "$D/anchors-tsv.txt" | sort -u > "$D/all.txt"
grep -v '^MISSING' "$D/anchors-tsv.txt" | cut -f2 | sort -u > "$D/found.txt"
comm -23 "$D/all.txt" "$D/found.txt" > "$D/missing.txt"
say "bundle 里找不到的词条 $(wc -l < "$D/missing.txt") 条（$D/missing.txt）：多数只在菜单/NLS 或 DOM 里出现，属正常；与上一版对比多出来的，才可能是改了英文文案"
say "只能走 DOM 的词条 $(grep -c '^UNSAFE' "$D/anchors-tsv.txt" || true) 条"
cat <<NEXT

下一步：
  1. git add anchors/$V.json && git commit（提交前看一眼 missing.txt：改了英文文案的，按新英文补词典后重跑本脚本）
  2. 在 box 的 Cursor 上实测：sh scripts/reinstall-cursor-box.sh（如需）→ node scripts/run.mjs localize → node scripts/coverage-scan.mjs
  3. 重新打包：node scripts/build-desktop.mjs && node scripts/build-desktop.mjs --win && node scripts/build-desktop.mjs --mac
NEXT
