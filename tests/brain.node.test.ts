import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrainStore, BrainStoreError } from '../brain.js';

function fixture(): { root: string; brain: BrainStore; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supper-brain-node-'));
  const brain = new BrainStore(root);
  return { root, brain, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Node Brain imports old dashboard stores once after a verified backup and retains originals', () => {
  const { root, brain, cleanup } = fixture();
  try {
    fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    const historyPath = path.join(root, 'memory/dashboard_history.json');
    const notesPath = path.join(root, 'memory/dashboard_memory.json');
    const knowledgePath = path.join(root, 'runtime/knowledge.json');
    const history = [{ id: 'legacy-one', speaker: 'user', text: 'A prior dashboard question', timestamp: 1_700_000_000_000 }];
    const notes = [{ id: 2, text: 'Owner asked to keep the garden notes', at: '2025-01-01T00:00:00.000Z' }];
    const knowledge = { entries: [{ id: 'owner-1', kind: 'owner', question: 'Tea?', answer: 'Green tea.' }], archive: [] };
    fs.writeFileSync(historyPath, JSON.stringify(history));
    fs.writeFileSync(notesPath, JSON.stringify(notes));
    fs.writeFileSync(knowledgePath, JSON.stringify(knowledge));
    const originalHashes = [historyPath, notesPath, knowledgePath].map((file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));

    const status = brain.initializeMemoryStore();
    assert.equal(status.available, true);
    assert.equal(status.migration.state, 'complete');
    assert.equal(status.migration.imported['memory/dashboard_history.json'], 1);
    assert.equal(status.migration.imported['memory/dashboard_memory.json'], 1);
    assert.equal(status.migration.imported['runtime/knowledge.json'], 1);
    assert.equal(brain.listMemories().some((row) => row.value.includes('garden notes')), true);
    assert.equal(brain.getRecentUiHistory().some((row) => row.text === 'A prior dashboard question'), true);
    assert.deepEqual([historyPath, notesPath, knowledgePath].map((file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')), originalHashes);
    assert.equal(brain.listBackups().length, 1);
    assert.equal(brain.listBackups()[0].verified, true);

    const repeated = brain.migrateLegacyMemory();
    assert.equal(repeated.state, 'complete');
    assert.equal(brain.listMemories().filter((row) => row.source_type === 'dashboard_memory').length, 1);
  } finally { cleanup(); }
});

test('Node chat turns retain topic continuity without crossing into another topic history', () => {
  const { brain, cleanup } = fixture();
  try {
    const first = brain.createTopic('Supper memory engine', 'Build local memory continuity');
    const firstTurn = brain.beginTurn('We decided: keep the Brain local and topic scoped.', { topicId: first.id });
    const captured = brain.captureFromUserMessage('We decided: keep the Brain local and topic scoped.', first.id);
    assert.equal(captured[0]?.value, 'keep the Brain local and topic scoped.');
    brain.appendTurn(firstTurn, 'user', 'We decided: keep the Brain local and topic scoped.');
    brain.appendTurn(firstTurn, 'assistant', 'Understood.');
    brain.summarizeConversation(firstTurn, 'We decided: keep the Brain local and topic scoped.', 'Understood.');

    const second = brain.createTopic('Garden planner', 'Plan a garden');
    const secondConversation = brain.createConversation(second.id);
    const secondTurn = brain.beginTurn('Help me plan the garden beds.', { topicId: second.id, conversationId: secondConversation.conversation_id });
    assert.equal(secondTurn.history.some((turn) => turn.parts[0].text.includes('Brain local')), false);
    assert.equal(secondTurn.context_block.includes('Supper memory engine'), false);

    const resumed = brain.beginTurn('Continue the garden plan.', { topicId: second.id });
    assert.equal(resumed.conversation_id, secondTurn.conversation_id);
    assert.equal(brain.getTopic(second.id)?.status, 'active');
  } finally { cleanup(); }
});

test('Node Brain corrects by category and topic, records decisions/tasks, and requires confirmation to forget', () => {
  const { brain, cleanup } = fixture();
  try {
    const topic = brain.createTopic('Home assistant project');
    brain.saveMemory('preferences', 'tea', 'earl grey');
    const corrected = brain.correctExplicitMemory('preferences', 'tea', 'rooibos', '', 'owner correction');
    assert.equal(corrected.value, 'rooibos');
    const preferenceHistory = brain.listMemories({ category: 'preferences', includeSuperseded: true });
    assert.equal(preferenceHistory.find((row) => row.value === 'earl grey')?.status, 'superseded');

    brain.captureFromUserMessage('The project goal is a dependable local assistant.', topic.id);
    brain.captureFromUserMessage('We decided: never merge Scenering into the main app.', topic.id);
    brain.captureFromUserMessage('Next step: add the topic picker to the dashboard.', topic.id);
    assert.equal(brain.getTopic(topic.id)?.goal, 'a dependable local assistant.');
    assert.equal(brain.listDecisions(topic.id).length, 1);
    assert.equal(brain.listTasks(topic.id, 'open').length, 1);

    const pending = brain.requestMemoryForget(corrected.id);
    assert.equal(brain.listMemories({ category: 'preferences' }).some((row) => row.id === corrected.id), true);
    assert.throws(() => brain.deleteMemory(pending.memory.id), (error: unknown) => error instanceof BrainStoreError && error.code === 'confirmation_required');
    assert.equal(brain.deleteMemory(pending.memory.id, true), true);
    assert.equal(brain.listMemories({ category: 'preferences' }).some((row) => row.id === corrected.id), false);
    assert.equal(brain.status().backup.count >= 1, true);
  } finally { cleanup(); }
});

test('Node Brain research indexing is URL-filtered, topic-scoped, and idempotent by report reference', () => {
  const { brain, cleanup } = fixture();
  try {
    const topic = brain.createTopic('Current transit research');
    const source = { url: 'https://example.org/official', title: 'Official source', retrieved_at: '2026-10-12T00:00:00.000Z' };
    const first = brain.saveResearch(topic.id, 'Current transit timetable', 'A source-led summary.', [source, { url: 'javascript:alert(1)', title: 'Unsafe' }], {
      sourceReference: 'runtime/research/report-1.json', verification: 'search-grounded; page not independently audited',
    });
    const refreshed = brain.saveResearch('', 'Current transit timetable', 'A refreshed summary.', [source], {
      sourceReference: 'runtime/research/report-1.json',
    });
    assert.ok(first);
    assert.equal(refreshed?.id, first?.id);
    assert.equal(brain.listResearch(topic.id).length, 1);
    assert.equal(brain.listResearch(topic.id)[0].sources.length, 1);
    assert.equal(brain.listResearch(topic.id)[0].value, 'A refreshed summary.');
  } finally { cleanup(); }
});

test('Node Brain redacts credential-like dialogue and excludes legacy secrets from AI retrieval', () => {
  const { root, brain, cleanup } = fixture();
  try {
    const topic = brain.createTopic('Credential handling project');
    const turn = brain.beginTurn('The password is topsecretvalue', { topicId: topic.id });
    brain.appendTurn(turn, 'user', 'The password is topsecretvalue');
    const serializedTurns = fs.readFileSync(path.join(root, 'memory/recent_dialogue.json'), 'utf8');
    assert.equal(serializedTurns.includes('topsecretvalue'), false);
    const next = brain.beginTurn('Help continue the project work.', { topicId: topic.id });
    assert.equal(JSON.stringify(next.history).includes('topsecretvalue'), false);

    const storePath = path.join(root, 'memory/long_term.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    store.notes.imported_credential = { id: 'imported-credential-12345678', subject: 'old note', value: 'API key is ABCD-SECRET-VALUE', status: 'active', owner_id: 'local-owner' };
    fs.writeFileSync(storePath, JSON.stringify(store));
    assert.equal(brain.searchMemories('API key ABCD SECRET VALUE').length, 0);
    assert.equal(brain.buildBrainContext('API key ABCD SECRET VALUE', topic.id).includes('ABCD-SECRET-VALUE'), false);
  } finally { cleanup(); }
});

test('Node Brain refuses corrupt memory and reports partial migration without overwriting the source', () => {
  const { root, brain, cleanup } = fixture();
  try {
    fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
    const corrupt = '{ not json';
    fs.writeFileSync(path.join(root, 'memory/long_term.json'), corrupt);
    const status = brain.initializeMemoryStore();
    assert.equal(status.available, false);
    assert.equal(status.storage_error, 'unreadable');
    assert.equal(fs.readFileSync(path.join(root, 'memory/long_term.json'), 'utf8'), corrupt);
  } finally { cleanup(); }
});
