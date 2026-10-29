# Cursor 一键汉化工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 box 本机交付可运行的 Electron 一键汉化工具（MS 语言包 + 静态补丁 + DOM 补漏），仅操作 box 上的 Cursor，绝不触碰用户电脑上的 Cursor。

**Architecture:** `packages/engine` 纯 Node 引擎负责探测/备份/语言包/补丁/注入/还原；`packages/dom-extension` 为注入到 Cursor 的补漏扩展；`apps/desktop` Electron GUI 调用引擎。词典与锚点分目录，按 Cursor Stable 版本加载。

**Tech Stack:** Node 20+、Electron、npm workspaces、node:test（或 vitest 若已装）、Linux 先验证。

## Global Constraints

- **ONLY box filesystem / box Cursor.** Never use machineId, never patch paths on the user's Mac.
- Platforms: Linux first; Win/macOS path tables stubbed but not required for green tests.
- Engine combo: MS `MS-CEINTL.vscode-language-pack-zh-hans` + static string patch + DOM extension.
- No hard patch when version anchors missing; backup before any write; fail → auto restore.
- Stable only; L1 panels required; YAGNI: no auth, no online dictionary update in v1.

## File map

```
/workspace/cursor-zh-localizer/
  package.json                 # workspaces root
  packages/engine/
    package.json
    src/index.js               # public API
    src/detect.js
    src/backup.js
    src/langpack.js
    src/patch.js
    src/inject.js
    src/restore.js
    src/anchors.js
    src/state.js
    test/*.test.js
  packages/dom-extension/
    package.json
    extension.js
    package.json (vscode extension manifest)
  anchors/linux/<version>.json
  dicts/zh-cn.json
  apps/desktop/
    package.json
    main.js
    preload.js
    index.html
    renderer.js
  README.md
```

---

### Task 1: Scaffold monorepo + engine detect

**Files:**
- Create: `package.json`
- Create: `packages/engine/package.json`
- Create: `packages/engine/src/detect.js`
- Create: `packages/engine/src/index.js`
- Create: `packages/engine/test/detect.test.js`
- Create: `README.md` (one paragraph: box-only warning)

**Interfaces:**
- Produces: `detectCursor(options?: { platform?: string, env?: NodeJS.ProcessEnv, whichPath?: string|null, extraRoots?: string[] }) => Promise<{ root: string, version: string, productPath: string } | null>`

- [ ] **Step 1: Write failing test**

```js
// packages/engine/test/detect.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectCursor } from '../src/detect.js';

describe('detectCursor', () => {
  it('reads version from product.json under a candidate root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-fake-'));
    await fs.writeFile(
      path.join(root, 'product.json'),
      JSON.stringify({ nameShort: 'Cursor', version: '1.2.3' }),
    );
    const found = await detectCursor({ extraRoots: [root], platform: 'linux' });
    assert.equal(found?.version, '1.2.3');
    assert.equal(found?.root, root);
  });

  it('returns null when nothing found', async () => {
    const found = await detectCursor({ extraRoots: ['/no/such/cursor-root-xyz'], platform: 'linux' });
    assert.equal(found, null);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd /workspace/cursor-zh-localizer && npm init -y && npm pkg set type=module workspaces='["packages/*","apps/*"]' && mkdir -p packages/engine/src packages/engine/test && cd packages/engine && npm init -y && npm pkg set type=module name=@cursor-zh/engine main=src/index.js && node --test test/detect.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Minimal detect implementation**

```js
// packages/engine/src/detect.js
import fs from 'node:fs/promises';
import path from 'node:path';

const LINUX_DEFAULTS = ['/usr/share/cursor', '/opt/cursor', '/opt/Cursor'];

export async function detectCursor({
  platform = process.platform,
  extraRoots = [],
} = {}) {
  const roots = [
    ...extraRoots,
    ...(platform === 'linux' ? LINUX_DEFAULTS : []),
  ];
  for (const root of roots) {
    const productPath = path.join(root, 'product.json');
    try {
      const raw = await fs.readFile(productPath, 'utf8');
      const product = JSON.parse(raw);
      const version = product.version || product.cursorVersion;
      if (!version) continue;
      return { root, version: String(version), productPath };
    } catch {
      continue;
    }
  }
  return null;
}
```

```js
// packages/engine/src/index.js
export { detectCursor } from './detect.js';
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd /workspace/cursor-zh-localizer/packages/engine && node --test test/detect.test.js`

- [ ] **Step 5: Commit**

```bash
cd /workspace/cursor-zh-localizer
git add package.json packages/engine README.md
git commit -m "feat: scaffold engine and Cursor detect"
```

---

### Task 2: Backup + restore

**Files:**
- Create: `packages/engine/src/backup.js`
- Create: `packages/engine/src/restore.js`
- Create: `packages/engine/test/backup-restore.test.js`
- Modify: `packages/engine/src/index.js`

**Interfaces:**
- Consumes: none beyond fs
- Produces:
  - `createBackup({ installRoot, files: string[], backupDir }) => Promise<{ manifestPath: string, files: { relative: string, sha256: string }[] }>`
  - `restoreBackup({ installRoot, backupDir }) => Promise<void>`

- [ ] **Step 1: Failing test** — write file, backup, modify, restore, assert original content + sha

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement backup.js / restore.js** using `crypto.createHash('sha256')`, copy files preserving relative paths, write `manifest.json`

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** `feat: engine backup and restore`

---

### Task 3: Anchors + static patch

**Files:**
- Create: `packages/engine/src/anchors.js`
- Create: `packages/engine/src/patch.js`
- Create: `anchors/linux/test-fixture.json` (for unit tests)
- Create: `dicts/zh-cn.json` (small starter dict)
- Create: `packages/engine/test/patch.test.js`

**Interfaces:**
- Produces:
  - `loadAnchors({ platform, version, anchorsDir }) => object | null`
  - `applyPatch({ installRoot, anchors, dict }) => Promise<{ patched: string[] }>`
  - Anchor shape:

```json
{
  "version": "1.2.3",
  "files": [
    {
      "relative": "resources/app/out/vs/workbench/workbench.desktop.main.js",
      "replacements": [
        { "from": "Cursor Settings", "toKey": "cursor.settings" }
      ]
    }
  ],
  "checksumFiles": []
}
```

Dict shape: `{ "cursor.settings": "Cursor 设置" }`

- [ ] **Step 1: Test** — temp install tree with a js file containing `Cursor Settings`; apply patch; assert Chinese; missing anchor version returns null from loadAnchors

- [ ] **Step 2–5:** implement, pass, commit `feat: anchors and static patch`

---

### Task 4: Langpack helper (install VSIX into extensions dir)

**Files:**
- Create: `packages/engine/src/langpack.js`
- Create: `packages/engine/test/langpack.test.js`

**Interfaces:**
- Produces: `ensureLanguagePack({ extensionsDir, vsixPath?, download?: () => Promise<Buffer> }) => Promise<{ installed: boolean, extensionPath: string }>`
- Produces: `setLocaleZhCn({ userDataDir }) => Promise<void>` — writes `locale.json` or `argv.json` per Cursor layout discovered on box

- [ ] **Step 1: Test** with fake VSIX zip (minimal extension folder zipped) and temp extensionsDir

- [ ] **Step 2–5:** implement using `adm-zip` or `unzip` via child_process; prefer zero dep: if vsix is zip, use `unzip` CLI. Commit `feat: language pack install and locale`

---

### Task 5: DOM extension + inject

**Files:**
- Create: `packages/dom-extension/package.json` (publisher `cursor-zh`, name `dom-localizer`, main `extension.js`)
- Create: `packages/dom-extension/extension.js`
- Create: `packages/engine/src/inject.js`
- Create: `packages/engine/test/inject.test.js`

**Interfaces:**
- DOM extension: on activate, observe document and replace text nodes whose trim matches dict keys (exact match only)
- `injectDomExtension({ extensionsDir, extensionSourceDir }) => Promise<void>`
- `disableDomExtension({ extensionsDir }) => Promise<void>`

- [ ] **Step 1: Test** copy into temp extensionsDir, assert package.json exists under expected folder name

- [ ] **Step 2–5:** implement, commit `feat: DOM localizer extension inject`

---

### Task 6: Orchestrator API `localize` / `revert`

**Files:**
- Create: `packages/engine/src/state.js`
- Create: `packages/engine/src/localize.js`
- Create: `packages/engine/test/localize.test.js`
- Modify: `packages/engine/src/index.js`

**Interfaces:**
- `localize(opts) => Promise<{ ok: true } | { ok: false, error: string, restored: boolean }>`
- `revert(opts) => Promise<{ ok: boolean, error?: string }>`
- opts: `{ installRoot?, userDataDir, extensionsDir, backupBaseDir, anchorsDir, dictsDir, platform }`
- Flow: detect → loadAnchors (fail if null) → createBackup → ensureLanguagePack → setLocale → applyPatch → injectDom → write state
- On error: restoreBackup, return `{ ok:false, restored:true/false, error }`

- [ ] **Step 1: Integration-style test** with temp fake Cursor tree + fake vsix

- [ ] **Step 2–5:** implement, commit `feat: localize and revert orchestration`

---

### Task 7: Electron GUI (minimal)

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/main.js`
- Create: `apps/desktop/preload.js`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/renderer.js`

**Interfaces:**
- IPC: `localize`, `revert`, `getStatus` → calls engine
- UI: path/version/status, two buttons, log `<pre>`

- [ ] **Step 1: Wire package**, `npm install electron --save-dev` in apps/desktop

- [ ] **Step 2: main.js** creates window, handles IPC by importing `@cursor-zh/engine`

- [ ] **Step 3: Manual smoke** — `npx electron .` on box (via computerUse if needed); buttons call engine against **box** Cursor only

- [ ] **Step 4: Commit** `feat: electron desktop shell`

---

### Task 8: Install Cursor on box + real dry-run notes

**Files:**
- Create: `docs/box-validation-notes.md`

- [ ] **Step 1: Install Cursor on box only**

```bash
curl -fsSL https://downloads.cursor.com/keys/anysphere.asc | gpg --dearmor | sudo tee /etc/apt/keyrings/cursor.gpg > /dev/null
echo "deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/cursor.gpg] https://downloads.cursor.com/aptrepo stable main" | sudo tee /etc/apt/sources.list.d/cursor.list > /dev/null
sudo apt update && sudo apt install -y cursor
cursor --version
```

- [ ] **Step 2: Record real paths** (`product.json`, user data, extensions) into validation notes

- [ ] **Step 3: Build first real `anchors/linux/<version>.json`** from observed L1 strings (start tiny)

- [ ] **Step 4: Run localize on box Cursor → note failures → fix engine**

- [ ] **Step 5: Commit** anchors + notes `chore: box Cursor validation notes and first anchors`

---

## Spec coverage check

| Spec item | Task |
|-----------|------|
| detect | 1 |
| backup/restore | 2 |
| anchors/static patch | 3 |
| MS langpack + locale | 4 |
| DOM inject | 5 |
| orchestrate + fail rollback | 6 |
| Electron GUI | 7 |
| Linux box validation | 8 |
| Win/macOS full | deferred (stubs only in detect) |
| Never touch user machine | Global Constraints + README |

