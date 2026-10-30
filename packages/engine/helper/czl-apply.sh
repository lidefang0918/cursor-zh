#!/bin/sh
# cursor-zh-localizer 特权写入助手（唯一需要 root 的部分）。
# 只做一件事：按清单把“已准备好的文件”原子地放进 Cursor 安装目录，并逐个校验 sha256。
# 不解析 JS、不联网、不碰用户目录；补丁计算、备份都由普通权限的主程序完成。
#
# 用法：czl-apply.sh <清单文件>
# 清单（制表符分隔，UTF-8）：
#   第 1 行：CZL1<TAB><安装根目录，绝对路径>
#   其余行：<sha256><TAB><源文件绝对路径><TAB><相对安装根的目标路径>
#   以 ! 开头的行是写入后动作（只在 macOS 有效）：!codesign-adhoc（对 Cursor.app 做 ad-hoc 重签名）、!unquarantine（去掉隔离属性）
# 退出码：0 成功；2 清单/参数不合法；3 源文件校验失败；4 写入失败（已尽量还原）；5 写入后校验失败；6 重签名失败
# 兼容 Linux（GNU coreutils）和 macOS（BSD 工具）。
set -eu
umask 022
PATH=/usr/sbin:/usr/bin:/sbin:/bin
TAB=$(printf '\t')

die() { code=$1; shift; echo "czl-apply: $*" >&2; exit "$code"; }
OS=$(uname -s)
# 可移植的 realpath：目录用 cd -P，文件用所在目录 + 文件名（调用方已排除符号链接）
rpath() { if [ -d "$1" ]; then (cd -P -- "$1" 2>/dev/null && pwd -P); else d=$(cd -P -- "$(dirname -- "$1")" 2>/dev/null && pwd -P) || return 1; printf '%s/%s\n' "$d" "$(basename -- "$1")"; fi; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | cut -d' ' -f1; else shasum -a 256 -- "$1" | cut -d' ' -f1; fi; }
# 新文件继承原文件的属主和权限
copymeta() { if [ "$OS" = Darwin ]; then chown "$(stat -f '%u:%g' "$1")" "$2" && chmod "$(stat -f '%Lp' "$1")" "$2"; else chown --reference="$1" -- "$2" && chmod --reference="$1" -- "$2"; fi; }
[ $# -eq 1 ] || die 2 "用法：czl-apply.sh <清单文件>"
MANIFEST=$1
[ -f "$MANIFEST" ] || die 2 "清单不存在：$MANIFEST"

IFS="$TAB" read -r MAGIC ROOT < "$MANIFEST" || die 2 "清单为空"
[ "$MAGIC" = "CZL1" ] || die 2 "清单格式不对"
case "$ROOT" in /*) ;; *) die 2 "安装根必须是绝对路径：$ROOT" ;; esac
[ -d "$ROOT" ] || die 2 "安装根不存在"
ROOT=$(rpath "$ROOT") || die 2 "安装根不存在"
# 必须真是 Cursor 安装（有 product.json 且声明了 Cursor 的 nameShort）；macOS 安装根是 Cursor.app/Contents
APP=""
case "$ROOT" in *.app/Contents) [ "$OS" = Darwin ] && APP=${ROOT%/Contents} ;; esac
PRODUCT=""
for p in "$ROOT/resources/app/product.json" "$ROOT/Resources/app/product.json" "$ROOT/product.json"; do [ -f "$p" ] && PRODUCT=$p && break; done
[ -n "$PRODUCT" ] || die 2 "不是 Cursor 安装目录：$ROOT"
grep -q '"nameShort": *"Cursor"' "$PRODUCT" || die 2 "product.json 不是 Cursor：$PRODUCT"

LIST=$(mktemp); ITEMS=$(mktemp); ACTIONS=$(mktemp); trap 'rm -f "$LIST" "$ITEMS" "$ACTIONS"' EXIT
tail -n +2 "$MANIFEST" | grep -v '^!' > "$ITEMS" || true
tail -n +2 "$MANIFEST" | grep '^!' > "$ACTIONS" || true
while read -r ACT; do
  case "$ACT" in '!codesign-adhoc'|'!unquarantine') [ -n "$APP" ] || die 2 "动作只适用于 macOS 的 Cursor.app：$ACT" ;; *) die 2 "未知动作：$ACT" ;; esac
done < "$ACTIONS"
while IFS="$TAB" read -r SHA SRC REL; do
  [ -n "$SHA$SRC$REL" ] || continue
  printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{64}$' || die 2 "sha256 不合法：$SHA"
  case "$REL" in /*|*..*|"") die 2 "目标路径不合法：$REL" ;; esac
  # 只允许改 Cursor 应用代码目录里的 .js/.json
  case "$REL" in
    resources/app/*.js|resources/app/*.json|out/*.js|out/*.json|product.json) ;;
    # macOS：应用代码 + 还原时写回原始签名（主程序与 CodeResources）
    Resources/app/*.js|Resources/app/*.json|MacOS/Cursor|_CodeSignature/CodeResources) [ -n "$APP" ] || die 2 "不允许修改：$REL" ;;
    *) die 2 "不允许修改：$REL" ;;
  esac
  DST="$ROOT/$REL"
  [ -f "$DST" ] && [ ! -L "$DST" ] || die 2 "目标不是普通文件：$DST"
  REAL=$(rpath "$DST") || die 2 "目标不存在：$DST"
  case "$REAL" in "$ROOT"/*) ;; *) die 2 "目标逃出安装根：$REAL" ;; esac
  [ -f "$SRC" ] && [ ! -L "$SRC" ] || die 2 "源文件不存在：$SRC"
  GOT=$(sha256 "$SRC")
  [ "$GOT" = "$SHA" ] || die 3 "源文件校验失败：$SRC"
  printf '%s\t%s\t%s\n' "$SHA" "$SRC" "$REAL" >> "$LIST"
done < "$ITEMS"
[ -s "$LIST" ] || die 2 "清单里没有文件"

# 第一步：全部先拷成同目录下的 .czl-new（继承原文件属主和权限），任何一个失败就清理并退出，安装目录不变
while IFS="$TAB" read -r SHA SRC REAL; do
  if ! cp -- "$SRC" "$REAL.czl-new" || ! copymeta "$REAL" "$REAL.czl-new"; then
    while IFS="$TAB" read -r _ _ R; do rm -f -- "$R.czl-new"; done < "$LIST"
    die 4 "写入失败：$REAL（安装目录未改动）"
  fi
done < "$LIST"
# 第二步：逐个 rename 覆盖（同目录 rename 是原子的）
while IFS="$TAB" read -r SHA SRC REAL; do
  mv -f -- "$REAL.czl-new" "$REAL" || die 4 "替换失败：$REAL"
done < "$LIST"
# 第三步：校验
while IFS="$TAB" read -r SHA SRC REAL; do
  GOT=$(sha256 "$REAL")
  [ "$GOT" = "$SHA" ] || die 5 "写入后校验失败：$REAL"
  echo "OK $REAL"
done < "$LIST"
# 第四步（macOS）：改过 Resources 后原签名失效，按清单做 ad-hoc 重签名 / 去隔离属性
while read -r ACT; do
  case "$ACT" in
    '!codesign-adhoc') /usr/bin/codesign --force --sign - --preserve-metadata=entitlements "$APP" >&2 || die 6 "重签名失败：$APP"
      # 清掉按路径缓存的签名策略，否则同路径 ELECTRON_RUN_AS_NODE/子进程会被 SIGKILL
      ASIDE="$APP.czl-resign-$$"
      mv "$APP" "$ASIDE" && mv "$ASIDE" "$APP" || { mv "$ASIDE" "$APP" 2>/dev/null; die 6 "重签名后刷新路径失败：$APP"; }
      /usr/bin/codesign --verify --deep --strict "$APP" >&2 || die 6 "重签名后校验失败：$APP"; echo "SIGNED $APP" ;;
    '!unquarantine') /usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true; echo "UNQUARANTINED $APP" ;;
  esac
done < "$ACTIONS"
