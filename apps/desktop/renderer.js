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
};

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
    '请打开终端，执行下面这条命令（会要求输入你的登录密码）：',
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
      notice('error', '未找到 Cursor', ['支持的安装位置：/usr/share/cursor（deb/rpm）、/opt/cursor、~/.local/share/cursor；AppImage 版放在 ~/Applications 或 ~/Downloads 后点“刷新”。']);
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
    notice('warn', '汉化已失效', ['检测到 Cursor 被重装或更新，安装文件已恢复成原版英文。点“一键汉化”重新汉化即可（旧备份已自动留档，不会被用来覆盖新版本）。']);
  }
  if (s.readOnlyFs) {
    notice('error', '安装位于只读文件系统', [`${c.root} 所在的文件系统是只读的（通常是正在运行的 AppImage 镜像），无法修改。请使用 AppImage 的“解包后汉化”。`]);
  } else if (s.needsElevation && s.supported && !s.localized && !s.pending) {
    const how = s.elevation?.pkexec && s.elevation?.graphical
      ? '点击“一键汉化”后会弹出系统授权窗口（pkexec），输入密码即可；若授权窗口不可用，会改用免密 sudo 或给出一条终端命令。'
      : '系统没有可用的图形授权（pkexec）。将尝试免密 sudo；不行的话会给出一条需要在终端执行的 sudo 命令。';
    notice('info', '需要管理员权限', [
      `Cursor 安装在 ${c.root}，文件归 root 所有。${how}`,
      '只有“把准备好的文件放进安装目录”这一步以管理员身份运行（一个很小的脚本，逐个校验 sha256），本界面不会以 root 运行。',
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
  $('localize').disabled = blocked || (s.localized && !s.stale);
  $('revert').disabled = busy || !(s.state?.localized || s.pending);
}

async function run(action, opt = {}) {
  busy = true;
  $('localize').disabled = $('revert').disabled = true;
  clearNotices();
  try {
    const r = await E[action]({ ...(target ? { installRoot: target } : {}), ...opt });
    if (r.ok) {
      pendingAction = null;
      const done = action === 'localize' ? '✔ 汉化完成' : r.cancelledPending ? '✔ 已取消未完成的汉化' : '✔ 已还原';
      log(`${done}${r.relaunched ? '，Cursor 已重新打开' : '，重启 Cursor 后生效'}`, 'done');
    } else if (r.code === 'CURSOR_RUNNING') {
      busy = false;
      await refresh();
      notice('warn', 'Cursor 正在运行', [
        `${action === 'localize' ? '汉化' : '还原'}需要重启 Cursor 才能生效。`,
        '点“关闭 Cursor 并继续”：本工具会正常关闭 Cursor（和点关闭按钮一样，未保存的内容由 Cursor 自动保留），完成后按原来的方式重新打开它。',
      ], [['关闭 Cursor 并继续', () => run(action, { closeRunning: true }), true], ['取消', () => refresh()]]);
      return;
    } else if (r.code === 'NEED_ELEVATION') {
      busy = false;
      await refresh();
      clearNotices();
      commandNotice('需要管理员权限', r, action);
      log('✖ 需要管理员权限，请按提示在终端执行命令', 'err');
      return;
    } else {
      log(`✖ ${r.error}${r.restored === false ? '（未能完整回滚！）' : r.restored ? '（安装文件未改动）' : ''}`, 'err');
    }
  } catch (e) {
    log(`✖ ${e.message}`, 'err');
  }
  busy = false;
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
$('installs').onchange = (e) => { target = e.target.value; refresh(); };
refresh();
