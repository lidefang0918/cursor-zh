const $ = (id) => document.getElementById(id);
const log = (msg, cls) => {
  const line = document.createElement('div');
  line.textContent = msg;
  if (cls) line.className = cls;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
};

async function refresh() {
  const s = await window.engine.getStatus();
  $('root').textContent = s.cursor?.root ?? '未找到 Cursor';
  $('version').textContent = s.cursor ? `${s.cursor.version}（VS Code ${s.cursor.vscodeVersion}）${s.supported ? '' : ' — 暂未适配'}` : '-';
  $('state').textContent = s.stale ? '汉化已失效（Cursor 被重装或更新），可重新汉化' : s.localized ? `已汉化（${s.state.at}）` : '未汉化';
  $('localize').disabled = !s.cursor || !s.supported || s.localized;
  $('revert').disabled = !s.state.localized;
}

async function run(action) {
  $('localize').disabled = $('revert').disabled = true;
  try {
    const r = await window.engine[action]();
    if (r.ok) log(action === 'localize' ? '✔ 汉化完成，请重启 Cursor' : '✔ 已还原，请重启 Cursor');
    else log(`✖ ${r.error}${r.restored === false ? '（未能完整回滚！）' : r.restored ? '（已自动回滚）' : ''}`, 'err');
  } catch (e) {
    log(`✖ ${e.message}`, 'err');
  }
  await refresh();
}

window.engine.onLog((m) => log(m));
$('localize').onclick = () => run('localize');
$('revert').onclick = () => run('revert');
refresh();
