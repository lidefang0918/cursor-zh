import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File, exists } from './backup.js';

// 按 manifest 把备份覆盖回安装目录，并校验 sha256
export async function restoreBackup({ installRoot, backupDir }) {
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!(await exists(manifestPath))) throw new Error(`没有备份可还原：${manifestPath}`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  for (const { relative, sha256 } of manifest.files) {
    const dst = path.join(installRoot, relative);
    await fs.copyFile(path.join(backupDir, 'files', relative), dst);
    if ((await sha256File(dst)) !== sha256) throw new Error(`还原后校验不一致：${relative}`);
  }
  return manifest;
}

// 还原成功后删除备份，下次汉化重新备份原始文件
export async function dropBackup({ backupDir }) {
  await fs.rm(backupDir, { recursive: true, force: true });
}
