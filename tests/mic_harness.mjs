#!/usr/bin/env node
/**
 * Compatibility entry point for the former browser-microphone harness.
 *
 * The supported dashboard now uses the local faster-whisper path and app-local
 * Kokoro output, with an explicitly local browser TTS fallback. The maintained
 * fake-browser regressions live in voice-engine.node.test.mjs; run them here so
 * the old command cannot silently pass without checking anything.
 *
 * This does not exercise a physical microphone, speaker, browser, or model.
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
