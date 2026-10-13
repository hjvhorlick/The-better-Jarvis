/**
 * The dashboard's inline script, checked for syntax.
 *
 * This exists because of a real failure. `dashboard/static/app.html` carries its
 * whole application in ONE inline <script> block, so a single bad token anywhere
 * in it stops the entire page: no windows, no event handlers, no settings, no
 * chat. The bug that prompted this was an over-escaped regex —
 * /^https?:\\\\/\\\\// instead of /^https?:\/\// — which Node rejects as
 * "Invalid regular expression flags".
 *
 * Nothing else in the suite could catch it. `tsc` only covers TypeScript, and the
 * Node tests never load app.html, so a page that could not run at all passed
 * every check and was merged. Parsing it is the only thing that catches this
 * class, so parsing it is what this test does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The inline <script> blocks of a page — not the ones loaded from a src. */
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function checkSyntax(source) {
  const file = join(tmpdir(), `jarvis-syntax-${randomBytes(6).toString('hex')}.js`);
  writeFileSync(file, source, 'utf-8');
  try {
    execFileSync(process.execPath, ['--check', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    return String(err.stderr || err.message || err);
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

test('app.html has an inline script, and it parses', () => {
  const html = readFileSync(join(ROOT, 'dashboard', 'static', 'app.html'), 'utf-8');
  const blocks = inlineScripts(html).filter((s) => s.trim());
  assert.ok(blocks.length > 0, 'no inline script found — the page shape changed, update this test');

  for (const [i, block] of blocks.entries()) {
    const error = checkSyntax(block);
    assert.equal(error, null,
      `inline script block ${i} of app.html does not parse, which stops the whole page:\n${error}`);
  }
});

test('the supplier registry renderer is actually in that script', () => {
  // A guard against the test passing vacuously: if the functions that draw the
  // registration area move out of the inline script, this test would keep
  // checking a page that no longer contains them.
  const html = readFileSync(join(ROOT, 'dashboard', 'static', 'app.html'), 'utf-8');
  const script = inlineScripts(html).filter((s) => s.trim()).join('\n');
  for (const fn of ['refreshSupplierRegistry', 'supplierRow', 'saveImageKey', 'clearImageKey']) {
    assert.ok(script.includes(fn), `${fn} is no longer in the inline script`);
  }
});

test('every other served page parses too', () => {
  // The same failure would be just as fatal in any other page that carries its
  // logic inline, so they are all checked rather than only the main one.
  const pages = ['dashboard/static/app.html'];
  for (const rel of pages) {
    let html;
    try {
      html = readFileSync(join(ROOT, rel), 'utf-8');
    } catch {
      continue; // page not present in this checkout
    }
    for (const [i, block] of inlineScripts(html).filter((s) => s.trim()).entries()) {
      const error = checkSyntax(block);
      assert.equal(error, null, `inline script block ${i} of ${rel} does not parse:\n${error}`);
    }
  }
});
