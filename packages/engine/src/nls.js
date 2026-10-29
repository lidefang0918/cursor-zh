import fs from 'node:fs/promises';
import path from 'node:path';

// VS Code NLS 层（out/nls.messages.json，按下标取文案）。
// 语言包只覆盖 VS Code 自带的 key，Cursor 新增/改过的 key（菜单 &&File、Close Window 等）仍是英文，
// 这里按锚点里的下标把它们换成中文；保留 && 助记键，写成 VS Code 中文惯例 "文件(&&F)"。
export function nlsTranslate(msg, dict) {
  if (Object.hasOwn(dict, msg)) return dict[msg];
  const i = msg.indexOf('&&');
  if (i < 0) return null;
  const plain = msg.replace('&&', '');
  if (!Object.hasOwn(dict, plain) || !msg[i + 2]) return null;
  return `${dict[plain]}(&&${msg[i + 2].toUpperCase()})`;
}

export async function applyNls({ installRoot, anchors, dict }) {
  const missing = [];
  let replaced = 0;
  if (!anchors.nls?.entries?.length) return { replaced, missing };
  const abs = path.join(installRoot, anchors.nls.relative);
  const msgs = JSON.parse(await fs.readFile(abs, 'utf8'));
  for (const { index, from } of anchors.nls.entries) {
    const to = nlsTranslate(from, dict);
    if (msgs[index] !== from || !to) { missing.push(`${from}@${index}`); continue; }
    msgs[index] = to;
    replaced++;
  }
  if (replaced) await fs.writeFile(abs, JSON.stringify(msgs));
  return { replaced, missing };
}

// 带语言包启动时，Cursor 会把合并后的译文缓存到 <userData>/clp/<hash>.<locale>/<commit>/；
// 改了 nls.messages.json 后必须删掉这份缓存，下次启动会重新生成（只是缓存，不含登录状态）。
export async function clearNlsCache({ userDataDir, commit }) {
  const removed = [];
  const clp = path.join(userDataDir, 'clp');
  let packs = [];
  try { packs = await fs.readdir(clp); } catch { return removed; }
  for (const p of packs) {
    const dir = path.join(clp, p, commit);
    try { await fs.access(dir); } catch { continue; }
    await fs.rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}
