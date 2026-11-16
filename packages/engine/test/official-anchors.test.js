import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAnchors } from '../src/anchors.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const anchorsDir = path.join(root, 'anchors');
const official = (name) => /^\d+(\.\d+)+$/.test(name);
const versions = fs.readdirSync(anchorsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .filter(official)
  .sort();
const exprs = (s) => (s.match(/\$\{[^{}`]+\}/g) || []).sort().join();

describe('official anchors', () => {
  it('required adapted versions ship a shared anchors file for each listed platform', async () => {
    for (const version of ['3.27.14', '3.27.22', '3.28.7', '3.29.9', '3.29.15', '3.30.8', '3.30.14']) {
      const rel = path.join(anchorsDir, `${version}.json`);
      assert.ok(fs.existsSync(rel), `missing anchors/${version}.json`);
      const meta = JSON.parse(fs.readFileSync(rel, 'utf8'));
      const platforms = meta.platforms ?? ['linux', 'win32', 'darwin'];
      assert.ok(platforms.length >= 1, `${version} platforms`);
      for (const platform of platforms) {
        const a = await loadAnchors({ platform, version, anchorsDir });
        assert.ok(a, `${version} ${platform}`);
        assert.equal(a.source, 'shared', `${version} ${platform}`);
        assert.ok((a.files?.length ?? 0) >= 1, `${version} ${platform} files`);
      }
    }
  });

  it('every official anchors file has unique fragments, kept template expressions, and a matching manifest hash', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dicts/manifest.json'), 'utf8'));
    let dictLike = 0;
    for (const version of versions) {
      const rel = `anchors/${version}.json`;
      const raw = fs.readFileSync(path.join(root, rel));
      assert.equal(manifest.files[rel], crypto.createHash('sha256').update(raw).digest('hex'), `${rel} manifest hash`);
      const a = JSON.parse(raw.toString('utf8'));
      let fragments = 0;
      for (const f of a.files ?? []) {
        const seen = new Set();
        for (const g of f.fragments ?? []) {
          assert.ok(!seen.has(g.from), `${version} duplicate fragment in ${f.relative}: ${String(g.from).slice(0, 120)}`);
          seen.add(g.from);
          fragments++;
          if (String(g.from).startsWith('`')) {
            assert.equal(exprs(g.to), exprs(g.from), `${version}: ${g.from}`);
          }
        }
      }
      assert.ok(fragments > 0, `${version} has no fragments`);
      dictLike += fragments + (a.nls?.count ?? a.nls?.entries?.length ?? 0);
    }
    assert.ok(dictLike > 0, 'expected some dictionary-backed anchors');
  });
});
