// 打包 Linux 版界面（AppImage + deb）：先把运行需要的文件按仓库原结构装配到 .build/app，
// 这样 main.js 里的相对引用 ../../packages/engine 和引擎里的 REPO 路径都不用改。
// 用法：node scripts/build-desktop.mjs [--appimage|--deb]   产物：dist/
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(repo, '.build/app');
const desktop = path.join(repo, 'apps/desktop');
const rd = (p) => fs.readFile(path.join(repo, p), 'utf8').then(JSON.parse);
const desktopPkg = await rd('apps/desktop/package.json');
const electronVersion = (await rd('node_modules/electron/package.json')).version;

await fs.rm(stage, { recursive: true, force: true });
const copy = (rel) => fs.cp(path.join(repo, rel), path.join(stage, rel), { recursive: true });
for (const f of ['main.js', 'preload.cjs', 'index.html', 'renderer.js']) await copy(`apps/desktop/${f}`);
for (const d of ['packages/engine/src', 'packages/engine/helper', 'packages/engine/package.json', 'packages/dom-runtime', 'anchors', 'dicts']) await copy(d);

await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({
  name: 'cursor-zh-localizer',
  productName: 'cursor-zh-localizer',
  desktopName: 'cursor-zh-localizer.desktop',
  version: desktopPkg.version,
  description: 'Cursor 一键汉化：把 Cursor 界面翻译成简体中文，可一键还原',
  author: { name: '阿三', email: 'asan@local' },
  homepage: 'https://localhost/cursor-zh-localizer',
  license: 'MIT',
  type: 'module',
  main: 'apps/desktop/main.js',
}, null, 2));

const config = {
  appId: 'local.cursor-zh-localizer',
  // 安装目录 /opt/cursor-zh-localizer 不带空格/中文；菜单里显示的名字由 desktop.entry.Name 决定
  productName: 'cursor-zh-localizer',
  electronVersion,
  directories: { app: stage, output: path.join(repo, 'dist'), buildResources: path.join(desktop, 'build') },
  files: ['**/*'],
  asar: true,
  // 写入助手要能被 deb 的安装脚本拷走，所以不放进 asar
  asarUnpack: ['packages/engine/helper/**'],
  extraResources: [{ from: path.join(desktop, 'build/linux/local.cursor-zh-localizer.apply.policy'), to: 'polkit/local.cursor-zh-localizer.apply.policy' }],
  linux: {
    executableName: 'cursor-zh-localizer',
    artifactName: 'cursor-zh-localizer-${version}-${arch}.${ext}',
    category: 'Utility',
    syncDesktopName: true,
    synopsis: 'Cursor 一键汉化',
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    desktop: { entry: { Name: 'Cursor 一键汉化', Comment: '把 Cursor 界面翻译成简体中文' } },
  },
  deb: {
    depends: ['libgtk-3-0 | libgtk-3-0t64', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0 | libatspi2.0-0t64', 'libuuid1', 'libsecret-1-0'],
    recommends: ['pkexec | policykit-1'],
    afterInstall: path.join(desktop, 'build/linux/after-install.sh'),
    afterRemove: path.join(desktop, 'build/linux/after-remove.sh'),
  },
};
const cfgPath = path.join(repo, '.build/electron-builder.json');
await fs.writeFile(cfgPath, JSON.stringify(config, null, 2));

const only = process.argv.includes('--appimage') ? ['AppImage'] : process.argv.includes('--deb') ? ['deb'] : ['AppImage', 'deb'];
execFileSync(path.join(repo, 'node_modules/.bin/electron-builder'), ['--linux', ...only, '--x64', '--config', cfgPath, '--projectDir', stage, '--publish', 'never'], { stdio: 'inherit', cwd: repo });
