// test/adaptersSyntax.test.js
//
// Parser-syntax guard for entry-point scripts shipped to end users (#542).
//
// `evolver setup-hooks --platform=codex` copies `src/adapters/scripts/*.js`
// verbatim into the user's `.codex/hooks/` directory; the CLI entry
// `index.js` is referenced by `package.json#bin`. A SyntaxError in either
// blocks the user before any code can run, with no workaround.
//
// PR #110 introduced a duplicate `const path = require('path')` in
// evolver-session-end.js, and v1.85.1 shipped that to npm — fresh
// installs hit `SyntaxError: Identifier 'path' has already been declared`
// the first time the Stop hook fired. The existing vitest suite never
// loaded those scripts (they spawn their own node process), so the
// regression made it through pre-publish. `node --check` is parse-only,
// cheap, and runs on every entry-point file unconditionally.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function nodeCheck(absPath) {
  const res = spawnSync(process.execPath, ['--check', absPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status, stderr: res.stderr || '' };
}

function listJsFiles(dirRel) {
  const dirAbs = path.join(REPO_ROOT, dirRel);
  if (!fs.existsSync(dirAbs)) return [];
  return fs.readdirSync(dirAbs)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ rel: path.posix.join(dirRel, name), abs: path.join(dirAbs, name) }));
}

describe('adapter scripts parse without SyntaxError (#542)', () => {
  const targets = listJsFiles('src/adapters/scripts');
  assert.ok(targets.length > 0, 'expected at least one adapter script to guard');

  for (const t of targets) {
    it(`${t.rel} parses cleanly`, () => {
      const r = nodeCheck(t.abs);
      assert.equal(r.status, 0,
        `node --check failed for ${t.rel}:\n${r.stderr}`);
    });
  }
});

describe('CLI entry parses without SyntaxError (#542)', () => {
  it('index.js parses cleanly', () => {
    const indexJs = path.join(REPO_ROOT, 'index.js');
    if (!fs.existsSync(indexJs)) return; // dist-only builds may omit
    const r = nodeCheck(indexJs);
    assert.equal(r.status, 0, `node --check failed for index.js:\n${r.stderr}`);
  });
});
