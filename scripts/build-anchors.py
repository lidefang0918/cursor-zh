#!/usr/bin/env python3
"""按真实 Cursor 安装生成静态锚点清单（开发工具，不随 GUI 运行）。

用法：python3 scripts/build-anchors.py /usr/share/cursor [--platform linux]
读取 resources/app/product.json 的版本，扫描两个工作台 bundle，
只把"所有出现位置都像展示文案"的词条收入静态锚点；其余只走 DOM 补漏。
输出 anchors/<platform>/<version>.json，并打印 SAFE / UNSAFE / MISSING 报告。
"""
import glob, json, os, re, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLES = ['workbench.desktop.main.js', 'workbench.glass.main.js']
REQUIRED = {('workbench.desktop.main.js', 'Cursor Settings'), ('workbench.desktop.main.js', 'Rules, Skills, Subagents')}
# 字面量前面出现这些 → 当作逻辑用法（比较、switch、对象键、集合查找、id/type 字段等），不做静态替换
UNSAFE_PREV = re.compile(r'(===|!==|==|!=|\bcase|\[|\bin|\.has\(|\.get\(|\.delete\(|includes\(|startsWith\(|endsWith\(|indexOf\(|\.set\(|\b(id|key|type|kind|mode|value|tabId|section|category|scheme|role|name|state|status|reason|source|variant|icon|command|menubarKey|glassCategory|category|action|error|prefix|group|when|event|tab|view|page|route|path)\s*:)\s*$')
# 单个词（无空格）碰撞风险高：每处出现都必须在这些展示字段后面，否则只走 DOM
DISPLAY_PREV = re.compile(r'(\b(label|title|children|tooltip|heading|description|placeholder|primaryLabel|secondaryLabel|defaultLabel|accessibleLabel|labelOutsidePicker|displayName|buttonText|text|message|detail|header|subtitle|ariaLabel)|"aria-label")\s*:\s*$')


def classify(src, s):
    n, bad = 0, []
    for q in '"\'`':
        if q in s:
            continue
        lit = q + s + q
        i = src.find(lit)
        while i >= 0:
            prev, nxt = src[max(0, i - 40):i], src[i + len(lit):i + len(lit) + 12]
            if re.search(r'original:\s*$', prev):  # 命令面板英文别名，引擎不会替换
                i = src.find(lit, i + 1)
                continue
            n += 1
            if re.search(r'\bvalue:\s*$', prev) and nxt.startswith(',original:'):  # {value, original} 展示文案
                i = src.find(lit, i + 1)
                continue
            objkey = nxt.startswith(':') and re.search(r'[{,]\s*$', prev)
            if ' ' not in s and not DISPLAY_PREV.search(prev):
                bad.append(prev[-30:] + '⟦' + s + '⟧' + nxt[:2])
            elif UNSAFE_PREV.search(prev) or objkey or nxt.startswith('=') or nxt.startswith('!=') or (nxt.startswith(']') and re.search(r'\[\s*$', prev)):
                bad.append(prev[-30:] + '⟦' + s + '⟧' + nxt)
            i = src.find(lit, i + 1)
    return n, bad


def nls_translate(msg, words):
    if msg in words:
        return words[msg]
    i = msg.find('&&')
    if i < 0 or msg.replace('&&', '', 1) not in words or i + 2 >= len(msg):
        return None
    return f"{words[msg.replace('&&', '', 1)]}(&&{msg[i + 2].upper()})"


def nls_entries(app, words, langpack):
    """语言包没覆盖（Cursor 自己加的 key）且词典里有的 NLS 文案 → [{index, from}]"""
    keys = json.load(open(os.path.join(app, 'out/nls.keys.json')))
    msgs = json.load(open(os.path.join(app, 'out/nls.messages.json')))
    tr = json.load(open(langpack))['contents']
    entries, i = [], 0
    for mod, ks in keys:
        have = tr.get(mod, {})
        for k in ks:
            if k not in have and nls_translate(msgs[i], words):
                entries.append({'index': i, 'from': msgs[i]})
            i += 1
    return entries


def main():
    root = sys.argv[1]
    platform = sys.argv[sys.argv.index('--platform') + 1] if '--platform' in sys.argv else 'linux'
    app = os.path.join(root, 'resources/app')
    product = json.load(open(os.path.join(app, 'product.json')))
    words = json.load(open(os.path.join(REPO, 'dicts/zh-cn.json')))
    srcs = {b: open(os.path.join(app, 'out/vs/workbench', b), encoding='utf-8').read() for b in BUNDLES}
    files, report = [], []
    for b in BUNDLES:
        strings = []
        for s in words:
            n, bad = classify(srcs[b], s)
            if n and not bad:
                strings.append({'from': s, **({'required': True} if (b, s) in REQUIRED else {})})
            report.append(f"{'SAFE' if n and not bad else 'UNSAFE' if n else 'MISSING':7} {b[10:20]} n={n:<3} {s!r} {bad[:1]}")
        files.append({'relative': f'resources/app/out/vs/workbench/{b}', 'strings': strings})
    anchors = {
        'version': product['version'], 'vscodeVersion': product.get('vscodeVersion'), 'commit': product.get('commit'),
        'note': '静态锚点只收录所有出现位置都像展示文案的整段字面量；其余词条只走 DOM 补漏。由 scripts/build-anchors.py 生成',
        'productJson': 'resources/app/product.json', 'checksumBase': 'resources/app/out',
        'dom': {'relatives': [f['relative'] for f in files]}, 'files': files,
    }
    lp = sys.argv[sys.argv.index('--langpack') + 1] if '--langpack' in sys.argv else (sorted(glob.glob(os.path.expanduser(
        f"~/.cursor/extensions/ms-ceintl.vscode-language-pack-zh-hans-{product.get('vscodeVersion')}*/translations/main.i18n.json"))) or [None])[-1]
    if lp:
        anchors['nls'] = {'relative': 'resources/app/out/nls.messages.json', 'langpack': os.path.basename(os.path.dirname(os.path.dirname(lp))),
                          'entries': nls_entries(app, words, lp)}
        print(f"nls: {len(anchors['nls']['entries'])} untranslated messages covered by dict")
    out = os.path.join(REPO, 'anchors', platform, f"{product['version']}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(anchors, open(out, 'w'), ensure_ascii=False, indent=2)
    print('\n'.join(report))
    print(f"wrote {out}: " + ', '.join(f"{f['relative'].rsplit('/', 1)[1]}={len(f['strings'])}" for f in files))


if __name__ == '__main__':
    main()
