import fs from 'node:fs/promises';
import path from 'node:path';

const file = (dataDir) => path.join(dataDir, 'state.json');

export async function readState(dataDir) {
  try { return JSON.parse(await fs.readFile(file(dataDir), 'utf8')); }
  catch { return { localized: false }; }
}

export async function writeState(dataDir, state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file(dataDir), JSON.stringify(state, null, 2));
}
