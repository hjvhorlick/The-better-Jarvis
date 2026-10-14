#!/usr/bin/env node
/**
 * Compatibility entry point for the former standalone voice-reply harness.
 *
 * The old harness exercised a retired cloud-speech path and a user-selectable
 * remote voice, neither of which is part of the supported Node dashboard. Maintained local-first
 * speech and listening regressions now live in voice-engine.node.test.mjs and are
 * included in `npm run test:node`. Keep this filename working for anyone who used
 * the old command, but run the current suite rather than stale assertions.
 *
 * This uses fakes; it does not test a real microphone, speaker, or local model.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testFile = path.join(here, 'voice-engine.node.test.mjs');
const result = spawnSync(process.execPath, ['--test', testFile], {
  cwd: path.join(here, '..'),
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Could not start the maintained voice tests: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
