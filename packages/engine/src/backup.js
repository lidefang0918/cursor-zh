import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export async function sha256File(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// 把将要修改的文件按相对路径拷进 backupDir/files，并写 manifest.json（relative → sha256）
export async function createBackup({ installRoot, files, backupDir }) {
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (await exists(manifestPath)) {
    throw new Error(`已存在备份：${manifestPath}（请先还原，避免把已补丁文件当成原始文件备份）`);
  }
  const entries = [];
  for (const relative of [...new Set(files)]) {
    const src = path.join(installRoot, relative);
    const dst = path.join(backupDir, 'files', relative);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    entries.push({ relative, sha256: await sha256File(src) });
  }
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ installRoot, createdAt: new Date().toISOString(), files: entries }, null, 2),
  );
  return { manifestPath, files: entries };
}
