import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAnchors, supportedVersions, remapAnchors } from '../src/anchors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const anchorsDir = path.join(here, 'fixtures/anchors');
const repoAnchors = path.join(here, '../../../anchors');

describe('shared anchors', () => {
  it('falls back from anchors/<platform>/<ver>.json to the shared anchors/<ver>.json', async () => {
    const lin = await loadAnchors({ platform: 'linux', version: 'test-fixture', anchorsDir });
    assert.equal(lin.source, 'linux');
    const w = await loadAnchors({ platform: 'win32', version: 'test-shared', anchorsDir });
    assert.equal(w.source, 'shared');
    assert.equal(w.files[0].relative, 'resources/app/out/vs/workbench/workbench.desktop.main.js');
  });

  it('remaps resources/app → Resources/app for macOS (root = Cursor.app/Contents)', async () => {
    const m = await loadAnchors({ platform: 'darwin', version: 'test-pristine', anchorsDir });
    assert.equal(m.productJson, 'Resources/app/product.json');
    assert.equal(m.checksumBase, 'Resources/app/out');
    assert.equal(m.files[0].relative, 'Resources/app/out/vs/workbench/workbench.desktop.main.js');
    assert.deepEqual(Object.keys(m.pristine), ['Resources/app/out/vs/workbench/workbench.desktop.main.js']);
    assert.equal(remapAnchors(m, 'linux'), m);
  });

  it('honours the platforms list and lists versions per platform', async () => {
    assert.equal(await loadAnchors({ platform: 'darwin', version: 'test-linux-only', anchorsDir }), null);
    assert.deepEqual(await supportedVersions({ platform: 'darwin', anchorsDir }), ['test-pristine', 'test-shared']);
    assert.ok((await supportedVersions({ platform: 'linux', anchorsDir })).includes('test-fixture'));
    assert.ok((await supportedVersions({ platform: 'linux', anchorsDir })).includes('test-linux-only'));
  });

  it('ships 3.27.22 as one shared file for linux, win32 and darwin', async () => {
    for (const platform of ['linux', 'win32', 'darwin']) {
      const a = await loadAnchors({ platform, version: '3.27.22', anchorsDir: repoAnchors });
      assert.equal(a.source, 'shared', platform);
      assert.equal(a.dom.relatives.length, 2);
      assert.equal(Object.keys(a.pristine).length, 3);
      assert.ok(a.files[0].relative.startsWith(platform === 'darwin' ? 'Resources/app/' : 'resources/app/'));
    }
  });
  // 智能体窗口（glass）原生菜单栏：菜单对象里的 title 字面量 + 编辑菜单 N({key:"glassOsEdit…"},"&&Undo") 默认串
  it('translates the Agents-window native menu bar items (3.27.14 and 3.27.22)', async () => {
    for (const version of ['3.27.14', '3.27.22']) {
      const a = await loadAnchors({ platform: 'darwin', version, anchorsDir: repoAnchors });
      const glass = a.files.find((f) => f.relative.endsWith('workbench.glass.main.js'));
      const to = glass.fragments.map((f) => f.to).join('\n');
      for (const t of ['title:"新建智能体"', 'order:1,title:"更改"', 'order:2,title:"浏览器"', 'order:3,title:"文件"', 'order:4,title:"终端"', '"撤销(&&U)"', '"重做(&&R)"', '"剪切(&&T)"', '"复制(&&C)"', '"粘贴(&&P)"', '"全选(&&A)"', '"0_glassMacApp",order:0,title:"设置"']) {
        assert.ok(to.includes(t), `${version}: ${t}`);
      }
    }
  });
});
