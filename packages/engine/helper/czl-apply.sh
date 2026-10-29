#!/bin/sh
# cursor-zh-localizer 特权写入助手（唯一需要 root 的部分）。
# 只做一件事：按清单把“已准备好的文件”原子地放进 Cursor 安装目录，并逐个校验 sha256。
# 不解析 JS、不联网、不碰用户目录；补丁计算、备份都由普通权限的主程序完成。
#
# 用法：czl-apply.sh <清单文件>
# 清单（制表符分隔，UTF-8）：
#   第 1 行：CZL1<TAB><安装根目录，绝对路径>
#   其余行：<sha256><TAB><源文件绝对路径><TAB><相对安装根的目标路径>
# 退出码：0 成功；2 清单/参数不合法；3 源文件校验失败；4 写入失败（已尽量还原）；5 写入后校验失败
set -eu
umask 022
PATH=/usr/sbin:/usr/bin:/sbin:/bin
TAB=$(printf '\t')

die() { code=$1; shift; echo "czl-apply: $*" >&2; exit "$code"; }
[ $# -eq 1 ] || die 2 "用法：czl-apply.sh <清单文件>"
MANIFEST=$1
[ -f "$MANIFEST" ] || die 2 "清单不存在：$MANIFEST"

IFS="$TAB" read -r MAGIC ROOT < "$MANIFEST" || die 2 "清单为空"
[ "$MAGIC" = "CZL1" ] || die 2 "清单格式不对"
case "$ROOT" in /*) ;; *) die 2 "安装根必须是绝对路径：$ROOT" ;; esac
ROOT=$(realpath -e -- "$ROOT") || die 2 "安装根不存在"
# 必须真是 Cursor 安装（有 product.json 且声明了 Cursor 的 nameShort）
PRODUCT=""
for p in "$ROOT/resources/app/product.json" "$ROOT/product.json"; do [ -f "$p" ] && PRODUCT=$p && break; done
[ -n "$PRODUCT" ] || die 2 "不是 Cursor 安装目录：$ROOT"
grep -q '"nameShort": *"Cursor"' "$PRODUCT" || die 2 "product.json 不是 Cursor：$PRODUCT"

LIST=$(mktemp); ITEMS=$(mktemp); trap 'rm -f "$LIST" "$ITEMS"' EXIT
tail -n +2 "$MANIFEST" > "$ITEMS"
while IFS="$TAB" read -r SHA SRC REL; do
  [ -n "$SHA$SRC$REL" ] || continue
  printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{64}$' || die 2 "sha256 不合法：$SHA"
  case "$REL" in /*|*..*|"") die 2 "目标路径不合法：$REL" ;; esac
  # 只允许改 Cursor 应用代码目录里的 .js/.json
  case "$REL" in resources/app/*.js|resources/app/*.json|out/*.js|out/*.json|product.json) ;; *) die 2 "不允许修改：$REL" ;; esac
  DST="$ROOT/$REL"
  [ -f "$DST" ] && [ ! -L "$DST" ] || die 2 "目标不是普通文件：$DST"
  REAL=$(realpath -e -- "$DST")
  case "$REAL" in "$ROOT"/*) ;; *) die 2 "目标逃出安装根：$REAL" ;; esac
  [ -f "$SRC" ] && [ ! -L "$SRC" ] || die 2 "源文件不存在：$SRC"
  GOT=$(sha256sum -- "$SRC" | cut -d' ' -f1)
  [ "$GOT" = "$SHA" ] || die 3 "源文件校验失败：$SRC"
  printf '%s\t%s\t%s\n' "$SHA" "$SRC" "$REAL" >> "$LIST"
done < "$ITEMS"
[ -s "$LIST" ] || die 2 "清单里没有文件"

# 第一步：全部先拷成同目录下的 .czl-new（继承原文件属主和权限），任何一个失败就清理并退出，安装目录不变
while IFS="$TAB" read -r SHA SRC REAL; do
  if ! cp -- "$SRC" "$REAL.czl-new" || ! chown --reference="$REAL" -- "$REAL.czl-new" || ! chmod --reference="$REAL" -- "$REAL.czl-new"; then
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
  GOT=$(sha256sum -- "$REAL" | cut -d' ' -f1)
  [ "$GOT" = "$SHA" ] || die 5 "写入后校验失败：$REAL"
  echo "OK $REAL"
done < "$LIST"
