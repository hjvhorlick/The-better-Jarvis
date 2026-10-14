import assert from 'node:assert/strict';
import test from 'node:test';
import { preferredThinkingMode, speedConfig } from '../config.js';

test('speed settings reduce thinking without limiting reply length', () => {
  const current = speedConfig('gemini-3.8-flash');
  const legacy = speedConfig('gemini-2.5-flash');

  assert.equal(preferredThinkingMode('gemini-3.8-flash'), 'level');
  assert.equal(preferredThinkingMode('gemini-2.5-flash'), 'budget');
  assert.deepEqual(current, { temperature: 0.7, thinkingConfig: { thinkingLevel: 'LOW' } });
  assert.deepEqual(legacy, { temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } });
  assert.equal(Object.hasOwn(current, 'maxOutputTokens'), false);
  assert.equal(Object.hasOwn(legacy, 'maxOutputTokens'), false);
});
