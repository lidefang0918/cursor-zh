const $ = (id) => document.getElementById(id);
const E = window.engine;
const THEME_KEY = 'czl-theme';
const DETAILS_KEY = 'czl-details-open';
const LOG_KEY = 'czl-log-open';

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'onclick') n.onclick = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
}

function log(msg, cls) {
  if (busy && !cls) $('step').textContent = String(msg).replace(/^\s*[·⚠]\s*/, '');
  const line = el('div', cls ? { class: cls } : {}, msg);
  $('log').append(line);
  $('log').scrollTop = $('log').scrollHeight;
}

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
const DARWIN = E.platform === 'darwin';

let S = null;
let target = null;
let pendingAction = null;
let busy = false;
let current = null;
let session = { result: null, signFail: false };
let dialogOnConfirm = null;
let macFactsOpen = false;

function setTheme(mode) {
  const pref = mode || localStorage.getItem(THEME_KEY) || 'system';
  localStorage.setItem(THEME_KEY, pref);
  $('theme').value = pref;
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function notice(kind, title, body = [], buttons = []) {
  const box = el('div', { class: `notice ${kind}` }, el('div', { class: 'title' }, title));
  for (const b of [].concat(body)) box.append(typeof b === 'string' ? el('div', {}, b) : b);
  if (buttons.length) box.append(el('div', {}, buttons.map(([label, fn, primary]) => el('button', { onclick: fn, ...(primary ? { class: 'primary' } : {}) }, label))));
  $('notice').append(box);
  return box;
}
const clearNotices = () => $('notice').replaceChildren();

function closeDialog() {
  $('overlay').hidden = true;
  dialogOnConfirm = null;
}

function openDialog({ title, body, confirmLabel, cancelLabel = '取消', onConfirm }) {
  $('dialog-title').textContent = title;
  const box = $('dialog-body');
  box.replaceChildren();
  for (const b of [].concat(body)) box.append(typeof b === 'string' ? el('p', {}, b) : b);
  $('dialog-confirm').textContent = confirmLabel || '继续';
  $('dialog-cancel').textContent = cancelLabel;
  dialogOnConfirm = onConfirm;
  $('overlay').hidden = false;
  $('dialog-confirm').focus();
}

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

function elevationHow(s) {
  if (WIN) return '继续后 Windows 会弹出“用户账户控制”窗口，点“是”即可；若取消，会给出一条需要在管理员 PowerShell 中执行的命令。';
  if (s.elevation?.pkexec && s.elevation?.graphical) return '继续后会弹出系统授权窗口（pkexec），输入密码即可；若授权窗口不可用，会改用免密 sudo 或给出一条终端命令。';
  return '系统没有可用的图形授权（pkexec）。将尝试免密 sudo；不行的话会给出一条需要在终端执行的 sudo 命令。';
}

function quitCopy(action) {
  const verb = action === 'revert' ? '还原' : '汉化';
  return DARWIN
    ? `${verb}需要先退出 Cursor。点“关闭并继续”后，本工具会用和 ⌘Q 一样的方式请 Cursor 退出（Command+Q，不是强制结束，macOS 不会弹出“意外退出”）。请先保存工作；未保存的内容由 Cursor 自动保留，完成后按原来的方式重新打开它。`
    : `${verb}需要先退出 Cursor。点“关闭并继续”后，本工具会正常关闭 Cursor（和点关闭按钮一样）。请先保存工作；未保存的内容由 Cursor 自动保留，完成后按原来的方式重新打开它。`;
}

function macRiskCopy() {
  return [
    '写入后会用本机固定证书 cursor-zh-local 重签 Cursor.app。首次使用需要管理员授权，将该证书的公钥加入系统钥匙串信任（一次性）。',
    '若拒绝授权或授权失败，工具会报错并中止本次重签名，不会回退到 ad-hoc。',
    '已知限制：CS_KILLED（Code Signature Invalid）尚未完全修复。若遇到，请先还原英文，从 cursor.com 重新下载 Cursor 后再汉化。更新 Cursor 前也应先还原。',
  ];
}

function preflight(action, opt = {}) {
  if (busy || !$('overlay').hidden) return;
  const s = S;
  const body = [];
  let title = action === 'revert' ? '还原为英文原版？' : '继续汉化？';
  let confirmLabel = action === 'revert' ? '还原英文' : '继续';
  if (action === 'revert') body.push('将按备份把安装文件恢复为原版，macOS 上的官方签名也会一起恢复。');
  if (s?.running && !opt.closeRunning) {
    title = 'Cursor 正在运行';
    confirmLabel = '关闭并继续';
    body.push(quitCopy(action));
  }
  if (s?.needsElevation && s.supported && !s.readOnlyFs) {
    if (!s.running || opt.closeRunning) title = '需要管理员权限';
    body.push(`Cursor 安装在 ${s.cursor?.root}，${WIN ? '写入需要管理员权限' : '文件归 root 所有'}。${elevationHow(s)}`);
    body.push(`只有“把准备好的文件放进安装目录”这一步以管理员身份运行，本界面不会以${WIN ? '管理员' : ' root '}身份运行。`);
  }
  if (DARWIN && s?.cursor) {
    if (!body.length) title = '需要系统授权';
    body.push(...macRiskCopy());
  }
  if (!body.length) { run(action, opt); return; }
  if (s?.running && !opt.closeRunning) opt = { ...opt, closeRunning: true };
  openDialog({ title, body, confirmLabel, onConfirm: () => { closeDialog(); run(action, opt); } });
}

function setStatusView(s) {
  const title = $('status-title');
  const dot = $('status-dot');
  dot.className = 'dot';
  $('success-note').hidden = true;
  if (busy) { title.textContent = '正在处理'; dot.classList.add('idle'); return; }
  if (session.signFail) { title.textContent = '签名校验未通过'; dot.classList.add('bad'); return; }
  if (session.result === 'error') { title.textContent = '操作未完成'; dot.classList.add('bad'); return; }
  if (!s?.cursor) { title.textContent = '未找到 Cursor'; dot.classList.add('warn'); return; }
  if (s.stale) { title.textContent = '汉化已失效'; dot.classList.add('warn'); return; }
  if (s.localized) { title.textContent = '已是中文界面'; dot.classList.add('ok'); $('success-note').hidden = session.result !== 'success'; return; }
  title.textContent = '还未汉化';
}

function describeState(s) {
  clearNotices();
  const c = s.cursor;
  if (!c) {
    if (s.appImages?.length) {
      for (const a of s.appImages) {
        notice('info', `发现 AppImage 版 Cursor：${a.path}${a.version ? `（${a.version}）` : ''}`, [
          'AppImage 运行时是只读镜像（squashfs），任何权限都无法直接修改。',
          '可以“解包后汉化”：把它解包到 ~/.local/share/cursor-zh-localizer/cursor-appimage/，汉化解包出来的副本，并创建启动器“Cursor（中文）”和命令 ~/.local/bin/cursor-zh。原 AppImage 文件不会改动；解包副本不会随 AppImage 自动更新。',
        ], [['解包并汉化', () => extract(a.path), true]]);
      }
    } else {
      notice('error', '未找到 Cursor', [WIN
        ? '支持的安装位置：%LOCALAPPDATA%\\Programs\\cursor（用户版安装包）、C:\\Program Files\\cursor（系统版安装包）。装好 Cursor 后点“刷新”。'
        : DARWIN
          ? '支持的安装位置：/Applications/Cursor.app 或 ~/Applications/Cursor.app。装好后点“刷新”，或点“手动选择 Cursor.app”。'
          : '支持的安装位置：/usr/share/cursor（deb/rpm）、/opt/cursor、~/.local/share/cursor；AppImage 版放在 ~/Applications 或 ~/Downloads 后点“刷新”。',
      s.noRuntime ? '本工具借用 Cursor 自带的运行环境来执行汉化，所以需要先找到 Cursor。' : null].filter(Boolean),
      E.pickRoot ? [['手动选择 Cursor 安装位置…', pickRoot, true]] : []);
    }
    return;
  }
  if (s.otherInstall) notice('warn', '另一个 Cursor 安装处于汉化状态', [`${s.otherInstall} 已汉化。本工具一次只管理一个安装，请先切换到它并点“还原英文”。`]);
  if (s.pending && !s.pending.applied) {
    commandNotice('上次汉化在等待管理员权限', { command: s.pending.command }, 'localize');
  } else if (s.pending?.applied) {
    notice('info', '管理员命令已执行', ['补丁文件已写入安装目录，点主按钮完成剩余步骤（语言包、界面语言）。']);
  }
  if (!s.supported) {
    notice('error', `无法汉化 Cursor ${c.version}`, [
      `没在安装目录里找到 Cursor 的界面文件。已适配的版本：${s.supportedVersions?.join('、') || '无'}。`,
    ]);
  } else if (!s.exact && !s.localized) {
    notice('warn', `Cursor ${c.version} 是新版本，还没有专门适配`, [
      `可以照常汉化：会按 ${s.compatBase} 的词典尽力匹配，匹配不上的地方保持英文；不满意随时还原。本工具会自动从网上获取最新词典，适配好后再点一次即可补全。`,
    ]);
  }
  if (s.stale) {
    if (s.supported) {
      notice('warn', 'Cursor 已更新，汉化已失效', ['Cursor 被更新或重装后，安装文件变回了原版英文。点下面的按钮重新汉化即可（旧备份已自动留档，不会用来覆盖新版本）。']);
    } else {
      notice('warn', `Cursor 已更新到 ${c.version}，汉化已失效`, ['新版本的界面文件找不到，暂时无法汉化。']);
    }
  } else if (s.localized && s.upToDate === false) {
    notice('info', '有更新的汉化内容', ['本工具的词典/界面补漏比 Cursor 里现在用的更新（覆盖更全、修了问题）。点“更新汉化”即可，不需要先还原。']);
  }
  if (s.readOnlyFs) {
    notice('error', '安装位于只读文件系统', [`${c.root} 所在的文件系统是只读的（通常是正在运行的 AppImage 镜像），无法修改。请使用 AppImage 的“解包后汉化”。`]);
  }
  if ((s.kind === 'deb' || s.kind === 'rpm') && s.localized) {
    notice('info', '升级提示', [`通过 ${s.kind === 'deb' ? 'apt' : 'dnf/yum'} 升级 Cursor 后汉化会失效，届时打开本工具重新汉化即可。`]);
  }
  if (session.signFail) {
    notice('error', '签名校验未通过', [
      '已知限制，尚未完全修复，重试不能保证恢复。已抑制自动重开 Cursor，避免以不完整的安装启动。',
      el('div', { class: 'next' }, '下一步：先还原英文，从 cursor.com 重新下载 Cursor 后再汉化。请先验证 Cursor.app 完整性后再手动打开。'),
    ], [['打开日志文件', () => E.showLog()]]);
  }
}

function applyButtons(s) {
  const blocked = busy || !s.cursor || !s.supported || s.readOnlyFs || !!s.otherInstall;
  const loc = $('localize');
  const rev = $('revert');
  loc.hidden = false;
  loc.disabled = blocked;
  if (!s.cursor) {
    loc.textContent = '一键汉化';
    loc.disabled = true;
    loc.hidden = true;
  } else if (session.result === 'error' && !s.localized) {
    loc.textContent = '重试';
  } else if (s.stale) loc.textContent = '重新汉化';
  else if (s.localized && s.upToDate === false) loc.textContent = '更新汉化';
  else if (s.localized && s.upToDate !== false) {
    loc.hidden = true;
    loc.textContent = '一键汉化';
  } else loc.textContent = '一键汉化';
  // 没有当前安装时不可还原：过往 state.localized 残留不应把「还原英文」摆在主界面
  const canRevert = !!(s.cursor && (s.state?.localized || s.pending || s.localized || s.stale));
  rev.hidden = !canRevert;
  rev.disabled = busy || !canRevert;
  $('refresh').disabled = busy;
  $('installs').disabled = busy;
}

function renderDetails(s) {
  const box = $('details');
  const toggle = $('toggle-details');
  if (!s?.cursor) {
    box.replaceChildren();
    box.hidden = true;
    toggle.hidden = true;
    return;
  }
  toggle.hidden = false;
  const perm = s.readOnlyFs ? '只读，无法修改' : s.writable == null ? '—' : s.writable ? '可直接写入' : '需要管理员权限';
  const rows = [
    ['位置', s.cursor.root],
    ['版本', `${s.cursor.version} · VS Code ${s.cursor.vscodeVersion}`],
    ['安装方式', KIND[s.kind] ?? s.kind ?? '—'],
    ['写入权限', perm],
    ['词典', '在线词典（GitHub / 镜像），失败时用安装包内置词典'],
    ['诊断', [s.platform, s.elevation?.pkexec ? '可用 pkexec' : null, s.running ? 'Cursor 正在运行' : 'Cursor 未运行'].filter(Boolean).join(' · ')],
  ];
  const dl = el('dl', { class: 'details' });
  for (const [k, v] of rows) { dl.append(el('dt', {}, k), el('dd', {}, v)); }
  box.replaceChildren(dl);
  applyFolds();
}

function applyFolds() {
  const dOpen = localStorage.getItem(DETAILS_KEY) === '1';
  const lOpen = localStorage.getItem(LOG_KEY) === '1';
  $('details').hidden = !dOpen;
  $('log-wrap').hidden = !lOpen;
  $('toggle-details').querySelector('span').textContent = dOpen ? '▴' : '▾';
  $('toggle-log').querySelector('span').textContent = lOpen ? '▴' : '▾';
}

async function refresh() {
  const s = await E.getStatus(target ? { installRoot: target } : {});
  // 引擎异常（例如刚退出 Cursor 后瞬时读失败）不要把已经检测到的安装刷成「未找到 Cursor」
  if (s?.ok === false && s?.code && !s.cursor) {
    log(`⚠ 无法刷新状态：${s.error || s.code}`, 'err');
    if (S?.cursor) { applyButtons(S); return S; }
  }
  S = s;
  const sel = $('installs');
  const wrap = $('installs-wrap');
  const installs = s.installs ?? [];
  wrap.hidden = installs.length < 2;
  sel.hidden = installs.length < 2;
  if (!wrap.hidden) {
    sel.replaceChildren(...installs.map((i) => el('option', { value: i.root }, `${i.root}（${i.version}）`)));
    sel.value = s.cursor?.root ?? '';
  }
  const ver = $('version-line');
  if (!s.cursor) ver.replaceChildren();
  else {
    const badge = el('span', { class: `badge ${s.exact ? 'ok' : s.supported ? 'warn' : 'bad'}` }, s.exact ? '已适配' : s.supported ? '兼容模式' : '无法汉化');
    ver.replaceChildren(`Cursor ${s.cursor.version}`, badge);
  }
  $('running-line').hidden = !s.running;
  $('mac-hint').hidden = !DARWIN;
  $('mac-facts').hidden = !macFactsOpen;
  $('mac-hint-toggle').textContent = macFactsOpen ? 'macOS 签名存在已知限制 · 收起' : 'macOS 签名存在已知限制 · 查看';
  setStatusView(s);
  renderDetails(s);
  describeState(s);
  applyButtons(s);
}

const action2text = () => (current === 'revert' ? '还原' : '汉化');
const fail = (r) => {
  session.result = 'error';
  log(`✖ ${r.error}${r.restored === false ? '（未能完整回滚！）' : r.restored ? '（安装文件未改动）' : ''}`, 'err');
  notice('error', action2text(r) + '失败', [r.error, r.next ? el('div', { class: 'next' }, `下一步：${r.next}`) : null].filter(Boolean),
    [['打开日志文件', () => E.showLog()]]);
  setStatusView(S);
  applyButtons(S || {});
};

async function run(action, opt = {}) {
  busy = true;
  current = action;
  session.result = null;
  session.signFail = false;
  $('localize').disabled = $('revert').disabled = $('refresh').disabled = true;
  $('progress').hidden = false;
  $('step').textContent = action === 'localize' ? '正在汉化…' : '正在还原…';
  setStatusView(S);
  clearNotices();
  $('success-note').hidden = true;
  try {
    const r = await E[action]({ ...(target ? { installRoot: target } : {}), ...opt });
    if (r.ok) {
      pendingAction = null;
      if (r.signVerifyFailed) {
        session.signFail = true;
        log(`⚠ 签名校验未通过，不自动重开 Cursor：${r.signDetail || ''}`.trim(), 'err');
      } else {
        const done = action === 'localize' ? (r.already ? '✔ 已是最新汉化，无需重复操作' : r.refreshed ? '✔ 汉化已更新' : '✔ 汉化完成') : r.cancelledPending ? '✔ 已取消未完成的汉化' : '✔ 已还原';
        log(`${done}${r.unmatched ? `（已汉化 ${r.matched} 条，${r.unmatched} 条在此版本未匹配）` : ''}${r.relaunched ? '，Cursor 已重新打开' : r.already ? '' : '，重启 Cursor 后生效'}`, 'done');
        if (action === 'localize' && !r.already) session.result = 'success';
      }
    } else if (r.code === 'CURSOR_RUNNING') {
      busy = false;
      $('progress').hidden = true;
      await refresh();
      openDialog({
        title: 'Cursor 正在运行',
        body: [quitCopy(action)],
        confirmLabel: '关闭并继续',
        onConfirm: () => { closeDialog(); run(action, { ...opt, closeRunning: true }); },
      });
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
    session.result = 'error';
  }
  busy = false;
  $('progress').hidden = true;
  await refresh();
}

async function pickRoot() {
  const p = await E.pickRoot();
  if (!p) return;
  target = p;
  log(`已选择：${p}`);
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
  if (!S.localized) preflight('localize');
}

E.onLog((m) => log(m));
$('localize').onclick = () => preflight('localize');
$('revert').onclick = () => preflight('revert');
$('refresh').onclick = () => refresh();
$('showlog').onclick = () => E.showLog();
$('installs').onchange = (e) => { target = e.target.value; refresh(); };
$('theme').onchange = (e) => setTheme(e.target.value);
$('toggle-details').onclick = () => {
  const open = $('details').hidden;
  localStorage.setItem(DETAILS_KEY, open ? '1' : '0');
  applyFolds();
};
$('toggle-log').onclick = () => {
  const open = $('log-wrap').hidden;
  localStorage.setItem(LOG_KEY, open ? '1' : '0');
  applyFolds();
};
$('mac-hint-toggle').onclick = () => { macFactsOpen = !macFactsOpen; refresh(); };
$('dialog-cancel').onclick = closeDialog;
$('dialog-confirm').onclick = () => { const fn = dialogOnConfirm; if (fn) fn(); };
$('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closeDialog(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('overlay').hidden) { e.preventDefault(); closeDialog(); }
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') setTheme('system');
});

setTheme();
applyFolds();
$('localize').disabled = true;
$('revert').hidden = true;
refresh();
