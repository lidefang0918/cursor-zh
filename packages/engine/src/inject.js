import fs from 'node:fs/promises';
import path from 'node:path';

export const BEGIN = '/*CURSOR_ZH_DOM_BEGIN*/';
export const END = '/*CURSOR_ZH_DOM_END*/';
const RUNTIME_PATH = new URL('../../dom-runtime/runtime.js', import.meta.url);

export async function readRuntime() {
  return fs.readFile(RUNTIME_PATH, 'utf8');
}

// 包成自执行块；任何异常都吞掉，绝不影响 Cursor 工作台启动
export function buildInjection({ dict, patterns = [], runtimeSource }) {
  return `${BEGIN}\n;(function(DICT,PATTERNS){try{\n${runtimeSource}\nif(typeof document!=='undefined'&&typeof MutationObserver!=='undefined')cursorZhDom(DICT,document,MutationObserver,PATTERNS);\n}catch(e){try{console.warn('[cursor-zh] dom runtime failed',e)}catch(_){}}})(${JSON.stringify(dict)},${JSON.stringify(patterns)});\n${END}\n`;
}

export function stripInjection(src) {
  const i = src.indexOf(BEGIN);
  if (i < 0) return src;
  const j = src.indexOf(END, i);
  return src.slice(0, i).replace(/\n$/, '') + src.slice(j + END.length).replace(/^\n/, '');
}

// 追加到工作台主 bundle 末尾（扩展宿主没有 DOM，所以不用扩展形式）。还原靠备份覆盖。
export async function injectDomRuntime({ installRoot, relative, dict, patterns, runtimeSource }) {
  const file = path.join(installRoot, relative);
  const src = stripInjection(await fs.readFile(file, 'utf8'));
  const code = buildInjection({ dict, patterns, runtimeSource: runtimeSource ?? (await readRuntime()) });
  await fs.writeFile(file, src + '\n' + code);
  return { relative, bytes: Buffer.byteLength(code) };
}
