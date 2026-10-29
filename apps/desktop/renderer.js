const $ = (id) => document.getElementById(id);
const E = window.engine;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'onclick') n.onclick = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
}
const log = (msg, cls) => {
  if (busy && !cls) $('step').textContent = String(msg).replace(/^\s*[·⚠]\s*/, '');
  const line = el('div', cls ? { class: cls } : {}, msg);
  $('log').append(line);
  $('log').scrollTop = $('log').scrollHeight;
};

const KIND = {
  deb: 'deb 软件包（/usr/share/cursor，文件归 root 所有）',
  rpm: 'rpm 软件包（/usr/share/cursor，文件归 root 所有）',
  'appimage-extracted': 'AppImage 解包版（本工具解包，位于用户目录）',
  'appimage-mounted': 'AppImage（运行中的只读镜像）',
  manual: '手动安装 / 解压版',
  'win-user': '用户级安装（%LOCALAPPDATA%\\Programs\\cursor，无需管理员）',
  'win-system': '系统级安装（Program Files，写入时需要管理员/UAC）',
  'win-other': 'Windows 其他位置安装',
  'mac-applications': '/Applications 中的 Cursor.app',
  'mac-user-applications': '~/Applications 中的 Cursor.app',
  'mac-translocated': 'App 转移隔离路径（只读）',
  'mac-other': '其他位置的 Cursor.app',
};
const WIN = E.platform === 'win32';

let S = null;          // 最近一次状态
let target = null;     // 选中的安装根（null = 自动）
let pendingAction = null; // 等管理员命令后要“继续”的操作
let busy = false;

function notice(kind, title, body = [], buttons = []) {
  const box = el('div', { class: `notice ${kind}` }, el('div', { class: 'title' }, title));
  for (const b of [].concat(body)) box.append(typeof b === 'string' ? el('div', {}, b) : b);
  if (buttons.length) box.append(el('div', {}, buttons.map(([label, fn, primary]) => el('button', { onclick: fn, ...(primary ? { class: 'primary' } : {}) }, label))));
  $('notice').append(box);
  return box;
}
const clearNotices = () => $('notice').replaceChildren();

function commandNotice(title, r, action) {
  pendingAction = action;
  notice('warn', title, [
    r.tried?.length ? `已尝试：${r.tried.map((t) => `${t.via}（${t.reason}）`).join('；')}` : null,
    WIN ? '“用户账户控制”被取消或不可用。请以管理员身份打开 PowerShell（右键开始菜单 →“终端(管理员)”或“Windows PowerShell(管理员)”），执行下面这条命令：'
      : '请打开终端，执行下面这条命令（会要求输入你的登录密码）：',
    el('code', { class: 'cmd', id: 'sudo-cmd' }, r.command),
    '执行成功后（会显示几行 OK），回到这里点“我已执行，继续”。' + (r.cursorLeftClosed ? 'Cursor 暂时保持关闭，完成后会自动重新打开。' : ''),
  ].filter(Boolean), [
    ['复制命令', async () => { await E.copy(r.command); log('已复制命令到剪贴板'); }],
    ['我已执行，继续', () => run(action, { closeRunning: true }), true],
  ]);
}

function describeState(s) {
  clearNotices();
  const c = s.cursor;
  // —— 没找到安装 ——
  if (!c) {
    if (s.appImages?.length) {
      for (const a of s.appImages) {
        notice('info', `发现 AppImage 版 Cursor：${a.path}${a.version ? `（${a.version}）` : ''}`, [
          'AppImage 运行时是只读镜像（squashfs），任何权限都无法直接修改。',
          `可以“解包后汉化”：把它解包到 ~/.local/share/cursor-zh-localizer/cursor-appimage/，汉化解包出来的副本，并创建启动器“Cursor（中文）”和命令 ~/.local/bin/cursor-zh。原 AppImage 文件不会改动；解包副本不会随 AppImage 自动更新。`,
        ], [['解包并汉化', () => extract(a.path), true]]);
      }
    } else {
      notice('error', '未找到 Cursor', [WIN
        ? '支持的安装位置：%LOCALAPPDATA%\\Programs\\cursor（用户版安装包）、C:\\Program Files\\cursor（系统版安装包）。装好 Cursor 后点“刷新”。'
        : '支持的安装位置：/usr/share/cursor（deb/rpm）、/opt/cursor、~/.local/share/cursor；AppImage 版放在 ~/Applications 或 ~/Downloads 后点“刷新”。']);
    }
    return;
  }
  if (s.otherInstall) notice('warn', '另一个 Cursor 安装处于汉化状态', [`${s.otherInstall} 已汉化。本工具一次只管理一个安装，请先切换到它并点“一键还原”。`]);
  if (s.pending && !s.pending.applied) {
    commandNotice('上次汉化在等待管理员权限', { command: s.pending.command }, 'localize');
  } else if (s.pending?.applied) {
    notice('info', '管理员命令已执行', ['补丁文件已写入安装目录，点“一键汉化”完成剩余步骤（语言包、界面语言）。']);
  }
  if (!s.supported) {
    notice('error', `Cursor ${c.version} 暂未适配`, [
      `已适配的版本：${s.supportedVersions?.join('、') || '无'}。`,
      '为避免改坏 Cursor，本工具不会修改未适配的版本。请等待本工具更新，或安装已适配的 Cursor 版本。',
    ]);
  }
  if (s.stale) {
    if (s.supported) {
      notice('warn', 'Cursor 已更新，汉化已失效', ['Cursor 被更新或重装后，安装文件变回了原版英文。点下面的按钮重新汉化即可（旧备份已自动留档，不会用来覆盖新版本）。'],
        [['重新汉化', () => run('localize'), true]]);
    } else {
      notice('warn', `Cursor 已更新到 ${c.version}，汉化已失效`, ['本工具还没适配这个新版本，暂时无法汉化（为了不改坏 Cursor，本工具不会修改未适配的版本）。请等本工具更新后再点“一键汉化”。']);
    }
  } else if (s.localized && s.upToDate === false) {
    notice('info', '有更新的汉化内容', ['本工具的词典/界面补漏比 Cursor 里现在用的更新（覆盖更全、修了问题）。点“更新汉化”即可，不需要先还原。'],
      [['更新汉化', () => run('localize'), true]]);
  }
  if (s.readOnlyFs) {
    notice('error', '安装位于只读文件系统', [`${c.root} 所在的文件系统是只读的（通常是正在运行的 AppImage 镜像），无法修改。请使用 AppImage 的“解包后汉化”。`]);
  } else if (s.needsElevation && s.supported && !s.localized && !s.pending) {
    const how = WIN ? '点击“一键汉化”后 Windows 会弹出“用户账户控制”窗口，点“是”即可；若取消，会给出一条需要在管理员 PowerShell 中执行的命令。'
      : s.elevation?.pkexec && s.elevation?.graphical
      ? '点击“一键汉化”后会弹出系统授权窗口（pkexec），输入密码即可；若授权窗口不可用，会改用免密 sudo 或给出一条终端命令。'
      : '系统没有可用的图形授权（pkexec）。将尝试免密 sudo；不行的话会给出一条需要在终端执行的 sudo 命令。';
    notice('info', '需要管理员权限', [
      `Cursor 安装在 ${c.root}，${WIN ? '写入需要管理员权限' : '文件归 root 所有'}。${how}`,
      `只有“把准备好的文件放进安装目录”这一步以管理员身份运行（一个很小的脚本，逐个校验 sha256），本界面不会以${WIN ? '管理员' : ' root '}身份运行。`,
    ]);
  }
  if ((s.kind === 'deb' || s.kind === 'rpm') && s.localized) {
    notice('info', '提示', [`通过 ${s.kind === 'deb' ? 'apt' : 'dnf/yum'} 升级 Cursor 后汉化会失效，届时打开本工具重新点“一键汉化”即可。`]);
  }
}

async function refresh() {
  const s = await E.getStatus(target ? { installRoot: target } : {});
  S = s;
  const sel = $('installs');
  const installs = s.installs ?? [];
  sel.hidden = installs.length < 2;
  if (!sel.hidden) {
    sel.replaceChildren(...installs.map((i) => el('option', { value: i.root }, `${i.root}（${i.version}）`)));
    sel.value = s.cursor?.root ?? '';
  }
  $('root').textContent = sel.hidden ? (s.cursor?.root ?? '未找到 Cursor') : '';
  $('kind').textContent = s.cursor ? (KIND[s.kind] ?? s.kind ?? '-') : '-';
  $('version').replaceChildren(s.cursor ? `${s.cursor.version}（VS Code ${s.cursor.vscodeVersion}）` : '-',
    s.cursor ? el('span', { class: `badge ${s.supported ? 't-ok' : 't-bad'}` }, s.supported ? '已适配' : '暂未适配') : '');
  $('perm').replaceChildren(!s.cursor ? '-' : s.readOnlyFs ? el('span', { class: 't-bad' }, '只读，无法修改')
    : s.writable == null ? '-' : s.writable ? el('span', { class: 't-ok' }, '可直接写入') : el('span', { class: 't-warn' }, '需要管理员权限'));
  const st = s.stale ? el('span', { class: 't-warn' }, '汉化已失效（Cursor 被重装或更新）')
    : s.localized ? el('span', { class: 't-ok' }, `已汉化（${new Date(s.state.at).toLocaleString('zh-CN')}）`)
    : s.pending ? el('span', { class: 't-warn' }, s.pending.applied ? '等待完成' : '等待管理员权限') : '未汉化';
  $('state').replaceChildren(st, s.running ? el('span', { class: 'badge' }, 'Cursor 运行中') : '');
  describeState(s);
  const blocked = busy || !s.cursor || !s.supported || s.readOnlyFs || !!s.otherInstall;
  $('localize').disabled = blocked || (s.localized && s.upToDate !== false);
  $('localize').textContent = s.stale ? '重新汉化' : s.localized ? (s.upToDate === false ? '更新汉化' : '已汉化 ✔') : '一键汉化';
  $('revert').disabled = busy || !(s.state?.localized || s.pending);
}

const fail = (r) => {
  log(`✖ ${r.error}${r.restored === false ? '（未能完整回滚！）' : r.restored ? '（安装文件未改动）' : ''}`, 'err');
  notice('error', action2text(r) + '失败', [r.error, r.next ? el('div', { class: 'next' }, `下一步：${r.next}`) : null].filter(Boolean),
    [['打开日志', () => E.showLog()]]);
};
let current = null;
const action2text = () => (current === 'revert' ? '还原' : '汉化');

async function run(action, opt = {}) {
  busy = true;
  current = action;
  $('localize').disabled = $('revert').disabled = true;
  $('progress').hidden = false;
  $('step').textContent = action === 'localize' ? '正在汉化…' : '正在还原…';
  clearNotices();
  try {
    const r = await E[action]({ ...(target ? { installRoot: target } : {}), ...opt });
    if (r.ok) {
      pendingAction = null;
      const done = action === 'localize' ? (r.already ? '✔ 已是最新汉化，无需重复操作' : r.refreshed ? '✔ 汉化已更新' : '✔ 汉化完成') : r.cancelledPending ? '✔ 已取消未完成的汉化' : '✔ 已还原';
      log(`${done}${r.relaunched ? '，Cursor 已重新打开' : r.already ? '' : '，重启 Cursor 后生效'}`, 'done');
    } else if (r.code === 'CURSOR_RUNNING') {
      busy = false;
      $('progress').hidden = true;
      await refresh();
      notice('warn', 'Cursor 正在运行', [
        `${action === 'localize' ? '汉化' : '还原'}需要重启 Cursor 才能生效。`,
        '点“关闭 Cursor 并继续”：本工具会正常关闭 Cursor（和点关闭按钮一样，未保存的内容由 Cursor 自动保留），完成后按原来的方式重新打开它。',
      ], [['关闭 Cursor 并继续', () => run(action, { closeRunning: true }), true], ['取消', () => refresh()]]);
      return;
    } else if (r.code === 'NEED_ELEVATION') {
      busy = false;
      $('progress').hidden = true;
      await refresh();
      clearNotices();
      commandNotice('需要管理员权限', r, action);
      log(`✖ 需要管理员权限，请按提示在${WIN ? '管理员 PowerShell' : '终端'}执行命令`, 'err');
      return;
    } else if (r.code === 'MAC_APP_MANAGEMENT' || r.code === 'MAC_TRANSLOCATED') {
      busy = false;
      $('progress').hidden = true;
      await refresh();
      clearNotices();
      notice('warn', r.code === 'MAC_APP_MANAGEMENT' ? 'macOS 阻止了修改 Cursor.app' : 'Cursor.app 处于“App 转移”隔离路径', [
        r.error,
        ...(r.settingsUrl ? [`系统设置 → 隐私与安全性 → App 管理（${r.settingsUrl}）`] : []),
      ], [['我已处理，重试', () => run(action, opt), true], ['取消', () => refresh()]]);
      log(`✖ ${r.error}`, 'err');
      return;
    } else {
      busy = false;
      $('progress').hidden = true;
      await refresh();
      fail(r);
      return;
    }
  } catch (e) {
    log(`✖ ${e.message}`, 'err');
  }
  busy = false;
  $('progress').hidden = true;
  await refresh();
}

async function extract(p) {
  busy = true;
  clearNotices();
  const r = await E.extractAppImage(p);
  busy = false;
  if (!r.ok) { log(`✖ 解包失败：${r.error}`, 'err'); await refresh(); return; }
  target = r.root;
  await refresh();
  if (!S.localized) await run('localize');
}

E.onLog((m) => log(m));
$('localize').onclick = () => run('localize');
$('revert').onclick = () => run('revert');
$('refresh').onclick = () => refresh();
$('showlog').onclick = () => E.showLog();
$('installs').onchange = (e) => { target = e.target.value; refresh(); };
refresh();
