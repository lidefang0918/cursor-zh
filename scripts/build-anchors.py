#!/usr/bin/env python3
"""按真实 Cursor 安装生成静态锚点清单（开发工具，不随 GUI 运行）。

用法：python3 scripts/build-anchors.py <安装根> [--platform linux|win32|darwin] [--platforms darwin,...] [--seed anchors/<旧版本>.json] [--langpack <main.i18n.json>]
安装根：Linux /usr/share/cursor、Windows 解包出的 Cursor 目录、macOS 的 Cursor.app/Contents。
读取 resources/app（macOS 为 Resources/app）/product.json 的版本，扫描两个工作台 bundle，
只把"所有出现位置都像展示文案"的词条收入静态锚点；其余只走 DOM 补漏。
默认输出三平台共用的 anchors/<version>.json（路径统一写 resources/app/…，macOS 由引擎映射成 Resources/app/…）；
给了 --platform 则输出该平台专用覆盖 anchors/<platform>/<version>.json（只在某平台 bundle 不同时才需要）。
同时记录三个 bundle 文件的原版 sha256（pristine），引擎据此拒绝修改被别的工具改过的安装。打印 SAFE / UNSAFE / MISSING 报告。
"""
import glob, hashlib, json, os, re, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLES = ['workbench.desktop.main.js', 'workbench.glass.main.js']
REQUIRED = {('workbench.desktop.main.js', 'Cursor Settings'), ('workbench.desktop.main.js', 'Rules, Skills, Subagents')}
# 字面量前面出现这些 → 当作逻辑用法（比较、switch、对象键、集合查找、id/type 字段等），不做静态替换
UNSAFE_PREV = re.compile(r'(===|!==|==|!=|\bcase|\[|\bin|\.has\(|\.get\(|\.delete\(|includes\(|startsWith\(|endsWith\(|indexOf\(|\.set\(|\b(id|key|type|kind|mode|value|tabId|section|category|scheme|role|name|state|status|reason|source|variant|icon|command|menubarKey|glassCategory|category|action|error|prefix|group|when|event|tab|view|page|route|path)\s*:)\s*$')
# 单个词（无空格）碰撞风险高：每处出现都必须在这些展示字段后面，否则只走 DOM
DISPLAY_PREV = re.compile(r'(\b(label|title|children|tooltip|heading|description|placeholder|primaryLabel|secondaryLabel|defaultLabel|accessibleLabel|labelOutsidePicker|displayName|buttonText|text|message|detail|header|subtitle|ariaLabel)|"aria-label")\s*:\s*$')


# 这些词条在 bundle 里还当默认值写进用户数据并拿来比较（如 N2i="New Project" 与 t.name===N2i），
# 静态替换会让汉化前后的旧数据对不上，只走 DOM 补漏
DOM_ONLY = {'New Project'}


def classify(src, s):
    n, bad = 0, []
    if s in DOM_ONLY:
        return src.count(s), ['DOM_ONLY']
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


# 模板字面量 / JSX 拆分文案：整句里夹了 ${…} 或拆成数组，整段字面量替换够不着，改用“模板片段”精确替换。
# (正则, 替换函数)；每个 bundle 里按实际匹配文本生成 {from, to, count}，变量名随版本变化也能重新生成。
_K = r'\$\{(\w+)\?"\\u2318":"Ctrl\+"\}'
def _k(m):
    return '${' + m.group(1) + '?"\\u2318":"Ctrl+"}'
TEMPLATE_RULES = [
    (r'`Control whether agents can read files outside the workspace without approval\$\{', lambda m: '`控制智能体能否不经审批读取工作区外的文件${'),
    (r"`Mark Agent commits as 'Made with Cursor'\$\{", lambda m: '`将智能体提交标记为“Made with Cursor”${'),
    (r'`Automatically index repositories to speed up Grep searches\. All data is stored locally\.\$\{', lambda m: '`自动为仓库建立索引以加快 Grep 搜索。所有数据均存储在本地。${'),
    (r'`Use with caution\. Skip symlinks during \.cursorignore file discovery\. Enable only when all \.cursorignore files are reachable without symlinks\$\{',
     lambda m: '`谨慎使用。查找 .cursorignore 文件时跳过符号链接。仅当所有 .cursorignore 文件无需经过符号链接即可访问时才启用${'),
    (r'`Apply \.cursorignore files to all subdirectories\$\{', lambda m: '`将 .cursorignore 文件应用到所有子目录${'),
    (r'\?" \(controlled by admin\)":""', lambda m: '?"（由管理员控制）":""'),
    (r'\}\. Changing this setting requires restarting Cursor\.`', lambda m: '}。更改此设置需要重启 Cursor。`'),
    (r'children:\["Upgrade to ",', lambda m: 'children:["升级到 ",'),
    (r'return\["Upgrade to ",', lambda m: 'return["升级到 ",'),
    (r'children:\["Resets ",', lambda m: 'children:["重置于 ",'),
    # 编辑器标签页标题（标签栏属于文件名区，DOM 补漏不碰，只能静态改 getName）
    (r'getName\(\)\{return"Customize"\}', lambda m: 'getName(){return"自定义"}'),
    # Customize 页 "Browse Marketplace" 按钮拆成 ["Browse", <span> Marketplace</span>]
    (r'children:\["Browse",(\w+)\("span",\{className:"([^"]+)",children:" Marketplace"\}\)\]',
     lambda m: 'children:["浏览",' + m.group(1) + '("span",{className:"' + m.group(2) + '",children:"插件市场"})]'),
    (r'description:`Accept the next word of a suggestion via \$\{(\w+)\}`', lambda m: 'description:`通过 ${' + m.group(1) + '} 接受建议中的下一个单词`'),
    (r'description:`Automatically import necessary modules for \$\{(\w+)\}`', lambda m: 'description:`自动为 ${' + m.group(1) + '} 导入所需模块`'),
    (r'`Automatically parse links when pasted into Quick Edit \(' + _K + r'K\) input`', lambda m: '`粘贴到快速编辑（' + _k(m) + 'K）输入框时自动解析链接`'),
    (r'`Show a hint for ' + _K + r'K in the Terminal`', lambda m: '`在终端中显示 ' + _k(m) + 'K 提示`'),
    (r'label:`Preview Box for Terminal ' + _K + r'K`', lambda m: 'label:`终端 ' + _k(m) + 'K 预览框`'),
    (r'`Automatically jump to the next diff when accepting changes with ' + _K + r'Y`', lambda m: '`使用 ' + _k(m) + 'Y 接受更改时自动跳到下一处差异`'),
]


def template_fragments(src):
    out = {}
    for rx, fn in TEMPLATE_RULES:
        for m in re.finditer(rx, src):
            t = m.group(0)
            if t not in out:
                out[t] = {'from': t, 'to': fn(m), 'count': src.count(t)}
    return list(out.values())


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
    platform = sys.argv[sys.argv.index('--platform') + 1] if '--platform' in sys.argv else None
    app = next((os.path.join(root, d) for d in ('resources/app', 'Resources/app') if os.path.exists(os.path.join(root, d, 'product.json'))), None)
    if not app:
        sys.exit(f'找不到 resources/app/product.json：{root}')
    product = json.load(open(os.path.join(app, 'product.json')))
    words = json.load(open(os.path.join(REPO, 'dicts/zh-cn.json')))
    srcs = {b: open(os.path.join(app, 'out/vs/workbench', b), encoding='utf-8').read() for b in BUNDLES}
    out = os.path.join(REPO, 'anchors', *([platform] if platform else []), f"{product['version']}.json")
    prev = json.load(open(out)) if os.path.exists(out) else {}
    # --seed <旧版本锚点>：新版本没有旧文件时，从相邻版本继承手写片段（仍能按原次数精确匹配的才保留）
    seed = json.load(open(sys.argv[sys.argv.index('--seed') + 1])) if '--seed' in sys.argv else {}
    old = {f['relative']: f.get('fragments', []) for f in (prev or seed).get('files', [])}
    files, report = [], []
    for b in BUNDLES:
        strings = []
        for s in words:
            n, bad = classify(srcs[b], s)
            if n and not bad:
                strings.append({'from': s, **({'required': True} if (b, s) in REQUIRED else {})})
            report.append(f"{'SAFE' if n and not bad else 'UNSAFE' if n else 'MISSING':7} {b[10:20]} n={n:<3} {s!r} {bad[:1]}")
        rel = f'resources/app/out/vs/workbench/{b}'
        frags = [f for f in old.get(rel, []) if srcs[b].count(f['from']) == f['count']]  # 保留手写片段（仍能精确匹配的）
        for f in template_fragments(srcs[b]):
            if all(f['from'] != g['from'] for g in frags):
                frags.append(f)
        report.append(f"FRAGS   {b[10:20]} {len(frags)}")
        files.append({'relative': rel, 'strings': strings, 'fragments': frags})
    anchors = {
        'version': product['version'], 'vscodeVersion': product.get('vscodeVersion'), 'commit': product.get('commit'),
        'note': '静态锚点只收录所有出现位置都像展示文案的整段字面量；其余词条只走 DOM 补漏。由 scripts/build-anchors.py 生成',
        'productJson': 'resources/app/product.json', 'checksumBase': 'resources/app/out',
        'dom': {'relatives': [f['relative'] for f in files]}, 'files': files,
    }
    if not platform:
        anchors['platforms'] = (sys.argv[sys.argv.index('--platforms') + 1].split(',') if '--platforms' in sys.argv
                                else prev.get('platforms', ['linux', 'win32', 'darwin']))
    rels = [f['relative'] for f in files] + ['resources/app/out/nls.messages.json']
    anchors['pristine'] = {r: hashlib.sha256(open(os.path.join(app, r[len('resources/app/'):]), 'rb').read()).hexdigest() for r in rels}
    lp = sys.argv[sys.argv.index('--langpack') + 1] if '--langpack' in sys.argv else (sorted(glob.glob(os.path.expanduser(
        f"~/.cursor/extensions/ms-ceintl.vscode-language-pack-zh-hans-{product.get('vscodeVersion')}*/translations/main.i18n.json"))) or [None])[-1]
    if lp:
        anchors['nls'] = {'relative': 'resources/app/out/nls.messages.json', 'langpack': os.path.basename(os.path.dirname(os.path.dirname(lp))),
                          'entries': nls_entries(app, words, lp)}
        print(f"nls: {len(anchors['nls']['entries'])} untranslated messages covered by dict")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(anchors, open(out, 'w'), ensure_ascii=False, indent=2)
    print('\n'.join(report))
    print(f"wrote {out}: " + ', '.join(f"{f['relative'].rsplit('/', 1)[1]}={len(f['strings'])}" for f in files))


if __name__ == '__main__':
    main()
