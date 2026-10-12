/**
 * The dashboard's ONE source of truth for JARVIS settings.
 *
 * The dashboard used to carry its own private configuration: the key was read
 * only from process.env.GEMINI_API_KEY (the ./.env file written by Settings),
 * the model names were hardcoded at each call site, and the app's own budget,
 * names and settings file were ignored. Two configurations, one of them wrong.
 *
 * This module resolves everything exactly the way the engine room does, and
 * every Gemini call in server.ts goes through it:
 *
 *   KEY    GEMINI_API_KEY (the environment, including ./.env)
 *          then config/api_keys.json -> "gemini_api_key"
 *          (the same order as backend/config.py: get_gemini_api_key();
 *           the same key every actions/*.py reads)
 *
 *   MODEL  SUPPER_TEXT_MODEL (the app's own setting), then GEMINI_MODEL.
 *          Known Gemini 2.5 text overrides are migrated to CURRENT_TEXT_MODEL
 *          because Google now restricts access to 2.5 models for accounts that
 *          have not actively used them. The current stable model is tried before
 *          Google's moving alias (gemini-flash-latest), then the last working
 *          model. API discovery is the last resort after configured candidates.
 *
 *   NAMES  config/api_keys.json -> "assistant_name" / "user_name"
 *          (backend/config.py: get_assistant_name() / get_user_name())
 *
 *   QUOTA  SUPPER_GEMINI_DAILY_BUDGET (default 20, backend/config.py) and the
 *          counter in runtime/quota.json, shared with the engine room — the
 *          dashboard spends from the same daily budget, with the same rules:
 *          one unit per call that reaches Gemini, reset at local midnight,
 *          fail closed if the counter exists but cannot be read, and a 429
 *          from Google marks the day exhausted. Concurrent writes are made
 *          safe with a read-modify-write and an atomic rename.
 *          (The deliberate choice, and its one honest limitation, are written
 *          up in docs/CONFIG_SOURCE_OF_TRUTH.md.)
 *
 * Provenance: written for this project (CC BY-NC 4.0, see CREDITS.md). The
 * settings order, the field names and the quota rules mirror the existing
 * Python modules named above; no code was taken from another project.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// ── Where the app keeps its settings ────────────────────────────────────────
export const REPO_ROOT = process.cwd();
export const API_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'api_keys.json');
export const ENV_FILE = path.join(REPO_ROOT, '.env');
export const RUNTIME_DIR = path.join(REPO_ROOT, 'runtime');
export const QUOTA_FILE = path.join(RUNTIME_DIR, 'quota.json');
/**
 * The voice gets its own counter and its own limit. Speaking is not thinking:
 * a reply is one text call, but reading it out loud is a call per sentence, and
 * the owner wants the server voice on ALL the time. Sharing one budget would
 * mean twenty spoken sentences a day and no answers left — so the two are
 * counted apart, and both are visible in Settings.
 */
export const VOICE_QUOTA_FILE = path.join(RUNTIME_DIR, 'voice_quota.json');
export const MODEL_MEMORY_FILE = path.join(RUNTIME_DIR, 'dashboard_models.json');

/**
 * The model this app connects to — Google's CURRENT stable Flash model.
 *
 *   gemini-3.8-flash    GA 2 September 2026. "Our most intelligent Flash
 *                       model", 1M context, tunable thinking levels
 *                       (low / medium / high). Google tells NEW projects to use
 *                       3.8 Flash (or 3.5 Flash-Lite). Source:
 *                       ai.google.dev/gemini-api/docs/models, read 2026-10-12.
 *
 * This used to be the moving alias `gemini-flash-latest`. An alias is only as
 * good as the last time Google re-pointed it, and it was last moved on
 * 19 May 2026 — to gemini-3.5-flash, which 3.6 and 3.8 Flash have since
 * superseded and which Google no longer lists among its stable models. The
 * alias therefore left the app on a superseded generation with nothing in this
 * repository changing, which is exactly how "it is talking to the wrong Gemini
 * version" happens silently.
 *
 * Google's moving alias is kept as a fallback after the current stable model,
 * so a withdrawn or inaccessible model does not strand the Brain on an old pin.
 */
export const CURRENT_TEXT_MODEL = 'gemini-3.8-flash';
/**
 * Google's moving pointer, kept as the fallback: if the pinned name above is
 * withdrawn, whatever Google currently calls "flash-latest" answers instead.
 */
export const DEFAULT_TEXT_MODEL = 'gemini-flash-latest';
export const DEFAULT_DAILY_BUDGET = 20;           // backend/config.py
export const DEFAULT_VOICE_BUDGET = 400;          // spoken sentences a day

// The key may already be in the shell. Note that before dotenv runs, so the
// dashboard can say honestly whether the key came from the shell or from ./.env.
const KEY_FROM_SHELL = Boolean((process.env.GEMINI_API_KEY || '').trim());
// ./.env is git-ignored and is one of the two places the owner's key may live.
dotenv.config({ path: ENV_FILE });

// ── Files ───────────────────────────────────────────────────────────────────
function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** config/api_keys.json as the engine room sees it (an empty object when absent). */
export function readApiConfigFile(): Record<string, unknown> {
  return readJsonSafe(API_CONFIG_PATH) || {};
}

function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function envFileKey(): string {
  try {
    const line = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/)
      .find((l) => /^\s*(?:export\s+)?GEMINI_API_KEY\s*=/.test(l));
    if (!line) return '';
    return line.replace(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*/, '').trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

// ── KEY ─────────────────────────────────────────────────────────────────────
export type KeySource = 'environment' | '.env' | 'config/api_keys.json' | null;

export interface KeyInfo {
  key: string | null;
  source: KeySource;
  /** The last four characters only — the value itself is never reported or logged. */
  tail: string | null;
  /** A full sentence naming where the key was found (or every file that was checked). */
  detail: string;
}

export function resolveGeminiKey(): KeyInfo {
  const env = (process.env.GEMINI_API_KEY || '').trim();
  if (env) {
    const fromFile = envFileKey();
    const fromEnvFile = !KEY_FROM_SHELL && fromFile === env;
    const source: KeySource = fromEnvFile ? '.env' : 'environment';
    return {
      key: env,
      source,
      tail: env.slice(-4),
      detail: fromEnvFile
        ? 'read from ./.env (GEMINI_API_KEY) — the same file this dashboard has always written'
        : 'read from the environment (GEMINI_API_KEY, set outside ./.env — the shell or the launcher)',
    };
  }
  const file = readApiConfigFile();
  const value = typeof file['gemini_api_key'] === 'string' ? (file['gemini_api_key'] as string).trim() : '';
  if (value) {
    return {
      key: value,
      source: 'config/api_keys.json',
      tail: value.slice(-4),
      detail: 'read from config/api_keys.json (gemini_api_key) — the file the desktop app and every actions/*.py use',
    };
  }
  return {
    key: null,
    source: null,
    tail: null,
    detail: `no key found: I checked the environment (GEMINI_API_KEY, including ./.env) and ${API_CONFIG_PATH} (gemini_api_key)`,
  };
}

/** The key report an API response may carry — never the key itself. */
export function publicKeyInfo(info: KeyInfo = resolveGeminiKey()): {
  present: boolean; source: KeySource; tail: string | null; detail: string;
} {
  return { present: Boolean(info.key), source: info.source, tail: info.tail, detail: info.detail };
}

// ── NAMES ───────────────────────────────────────────────────────────────────
export interface NameInfo { assistant: string; user: string; source: string; }

export function resolveNames(): NameInfo {
  const file = readApiConfigFile();
  const assistantRaw = typeof file['assistant_name'] === 'string' ? (file['assistant_name'] as string).trim() : '';
  const userRaw = typeof file['user_name'] === 'string' ? (file['user_name'] as string).trim() : '';
  return {
    assistant: assistantRaw || 'JARVIS',       // backend/config.py: get_assistant_name()
    user: userRaw,                             // backend/config.py: get_user_name()
    source: 'config/api_keys.json (assistant_name / user_name)',
  };
}

export function assistantName(): string { return resolveNames().assistant; }

// ── MODEL ───────────────────────────────────────────────────────────────────
export interface ModelInfo { model: string; source: string; }
export interface ModelCandidate { model: string; source: string; }

function legacyTextModelReplacement(model: string): boolean {
  // Gemini 2.5 access is now restricted to accounts that used those models before.
  // Never let a stale environment setting pin the main Brain to that generation.
  return /^(?:models\/)?gemini-2\.5-(?:flash|pro)(?:-|$)/i.test(model.trim());
}

export function resolveTextModel(): ModelInfo {
  const appSetting = (process.env.SUPPER_TEXT_MODEL || '').trim();
  if (appSetting && legacyTextModelReplacement(appSetting)) {
    return {
      model: CURRENT_TEXT_MODEL,
      source: `legacy SUPPER_TEXT_MODEL (${appSetting}) automatically upgraded to ${CURRENT_TEXT_MODEL}`,
    };
  }
  if (appSetting) return { model: appSetting, source: 'SUPPER_TEXT_MODEL' };

  const pinned = (process.env.GEMINI_MODEL || '').trim();
  if (pinned && legacyTextModelReplacement(pinned)) {
    return {
      model: CURRENT_TEXT_MODEL,
      source: `legacy GEMINI_MODEL (${pinned}) automatically upgraded to ${CURRENT_TEXT_MODEL}`,
    };
  }
  if (pinned) return { model: pinned, source: 'GEMINI_MODEL' };

  return { model: CURRENT_TEXT_MODEL, source: `the app's current model (${CURRENT_TEXT_MODEL})` };
}

export function resolveImageModel(): ModelInfo {
  const setting = (process.env.SUPPER_IMAGE_MODEL || '').trim();
  if (setting) return { model: setting, source: 'SUPPER_IMAGE_MODEL' };
  const remembered = readRememberedModel('image');
  if (remembered) return { model: remembered, source: 'the last picture model that worked (runtime/dashboard_models.json)' };
  return { model: '', source: 'not set — I will ask your key which picture model it may use' };
}

/**
 * A test-and-gateway hook: point the Gemini client at another Gemini-compatible
 * address. Unset in normal use. tests/config_harness.mjs uses it to prove the
 * four call paths end to end without a real key.
 */
export function resolveBaseUrl(): string {
  return (process.env.SUPPER_GEMINI_BASE_URL || '').trim();
}

// What last worked. Remembering it means a working model keeps being used even
// when discovery is unavailable; it is dropped the moment a call fails.
function readModelMemory(): Record<string, { model: string; at: string }> {
  const data = readJsonSafe(MODEL_MEMORY_FILE) || {};
  const out: Record<string, { model: string; at: string }> = {};
  for (const key of ['text', 'image']) {
    const entry = data[key] as { model?: unknown; at?: unknown } | undefined;
    if (entry && typeof entry.model === 'string' && entry.model) {
      out[key] = { model: entry.model, at: typeof entry.at === 'string' ? entry.at : '' };
    }
  }
  return out;
}

export function readRememberedModel(kind: 'text' | 'image'): string {
  return readModelMemory()[kind]?.model || '';
}

export function rememberModel(kind: 'text' | 'image', model: string): void {
  if (!model) return;
  try {
    // Merge into whatever is already in the file. readModelMemory() only knows
    // the text/image sections, so writing it back on its own would wipe the
    // thinking settings that live beside them.
    const file = (readJsonSafe(MODEL_MEMORY_FILE) || {}) as Record<string, unknown>;
    const memory = readModelMemory();
    memory[kind] = { model, at: new Date().toISOString() };
    for (const [key, value] of Object.entries(memory)) file[key] = value;
    writeFileAtomic(MODEL_MEMORY_FILE, JSON.stringify(file, null, 2));
  } catch (err) {
    console.warn('[config] could not remember the working model:', err);
  }
}

/** Forget a model that failed, so it is not offered again before re-discovery. */
function forgetModel(kind: 'text' | 'image', model: string): void {
  try {
    const file = (readJsonSafe(MODEL_MEMORY_FILE) || {}) as Record<string, unknown>;
    const memory = readModelMemory();
    if (memory[kind]?.model === model) {
      delete memory[kind];
      delete file[kind];
      writeFileAtomic(MODEL_MEMORY_FILE, JSON.stringify(file, null, 2));
    }
  } catch { /* remembering is a convenience, never a hard dependency */ }
}

/**
 * Candidates are ordered so a valid owner override wins, followed by the app's
 * verified current stable text model, Google's moving alias, and only then a
 * remembered model. Legacy Gemini 2.5 text overrides and remembered values are
 * normalized/removed before they can be sent to Google.
 */
export function modelCandidates(kind: 'text' | 'image'): ModelCandidate[] {
  const list: ModelCandidate[] = [];
  const configured = kind === 'text' ? resolveTextModel() : resolveImageModel();
  if (configured.model) list.push({ model: configured.model, source: configured.source });

  if (kind === 'text') {
    if (!list.some((c) => c.model === CURRENT_TEXT_MODEL)) {
      list.push({ model: CURRENT_TEXT_MODEL, source: `the app's current stable text model (${CURRENT_TEXT_MODEL})` });
    }
    if (!list.some((c) => c.model === DEFAULT_TEXT_MODEL)) {
      list.push({ model: DEFAULT_TEXT_MODEL, source: `Google's moving alias (${DEFAULT_TEXT_MODEL}) — fallback after the current stable model` });
    }
  }

  const remembered = readRememberedModel(kind);
  if (remembered && kind === 'text' && legacyTextModelReplacement(remembered)) {
    // Do not let a stale local runtime cache bring Gemini 2.5 back after migration.
    forgetModel(kind, remembered);
  } else if (remembered && !list.some((c) => c.model === remembered)) {
    list.push({ model: remembered, source: 'remembered as working (runtime/dashboard_models.json)' });
  }
  return list;
}

// ── Discovery (last resort only) ────────────────────────────────────────────
// Nothing here is a model name: these are shape filters over whatever the
// owner's key is actually allowed to use (ai.models.list()).
const NOT_A_TEXT_MODEL = /embedding|aqa|tts|audio|transcribe|veo|lyria|imagen|learnlm|gemma|codey|vision/;
const PICTURE_MODEL = /image/;

function shortName(id: string): string {
  return id.replace(/^models\//, '').trim();
}

function isUsableModelName(id: string, kind: 'text' | 'image'): boolean {
  const name = shortName(id).toLowerCase();
  if (!name) return false;
  if (NOT_A_TEXT_MODEL.test(name)) return false;
  return kind === 'image' ? PICTURE_MODEL.test(name) : !PICTURE_MODEL.test(name);
}

function preferenceScore(id: string, kind: 'text' | 'image'): number {
  const name = shortName(id).toLowerCase();
  let score = 0;
  if (kind === 'text') {
    if (name.includes('flash')) score -= 4;
    else if (name.includes('pro')) score -= 2;
  }
  if (name.includes('latest')) score -= 2;        // a moving alias beats a dated name
  if (/\d{4}|-\d\d-\d\d/.test(name)) score += 2;  // dated/snapshot names are the ones that retire
  return score + name.length / 100;
}

export async function discoverModels(caller: BrainCaller, kind: 'text' | 'image'): Promise<ModelCandidate[]> {
  const ids = await caller.listModels();
  return ids
    .map(shortName)
    .filter((id) => isUsableModelName(id, kind))
    .sort((a, b) => preferenceScore(a, kind) - preferenceScore(b, kind))
    .map((model) => ({ model, source: 'discovered from your key (ai.models.list() — last resort)' }));
}

// ── QUOTA (the app's own daily budget) ──────────────────────────────────────
export interface QuotaSnapshot {
  day: string;
  used: number;
  limit: number;
  remaining: number;
  enabled: boolean;
  unreadable: boolean;
  saved: boolean;
  resets: string;
  source: string;
  note: string;
}

export interface BudgetInfo { limit: number; source: string; }

export function resolveDailyBudget(): BudgetInfo {
  const raw = (process.env.SUPPER_GEMINI_DAILY_BUDGET || '').trim();
  if (!raw) return { limit: DEFAULT_DAILY_BUDGET, source: `the app's default (${DEFAULT_DAILY_BUDGET})` };
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    return { limit: DEFAULT_DAILY_BUDGET, source: `the app's default (${DEFAULT_DAILY_BUDGET}) — SUPPER_GEMINI_DAILY_BUDGET could not be read` };
  }
  return { limit: value, source: 'SUPPER_GEMINI_DAILY_BUDGET' };
}

// A file that exists but cannot be read fails closed until the next local day
// (backend/quota.py holds the same rule). Each counter keeps its own state, so a
// damaged voice counter can never switch the brain off (or the other way round).
const unreadableDay: Record<string, string> = {};
const saveFailed: Record<string, boolean> = {};

function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface Counter { day: string; used: number; unreadable: boolean; }

function readCounter(file: string = QUOTA_FILE): Counter {
  const day = localDay();
  if (unreadableDay[file] === day) return { day, used: 0, unreadable: true };
  if (!fs.existsSync(file)) return { day, used: 0, unreadable: false };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { day?: unknown; used?: unknown };
    const used = Number(data?.used);
    if (!Number.isFinite(used) || used < 0) throw new Error('the counter is not a number');
    return { day, used: data?.day === day ? Math.floor(used) : 0, unreadable: false };
  } catch {
    unreadableDay[file] = day;              // fail closed: a damaged counter can never allow calls
    return { day, used: 0, unreadable: true };
  }
}

function writeCounter(day: string, used: number, file: string = QUOTA_FILE): void {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ day, used }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    saveFailed[file] = false;
  } catch {
    saveFailed[file] = true;                // counting continues in memory; diagnostics shows it
  }
}

export function quotaSnapshot(): QuotaSnapshot {
  const budget = resolveDailyBudget();
  const counter = readCounter();
  return {
    day: counter.day,
    used: counter.used,
    limit: budget.limit,
    remaining: counter.unreadable ? 0 : Math.max(0, budget.limit - counter.used),
    enabled: budget.limit > 0,
    unreadable: counter.unreadable,
    saved: !saveFailed[QUOTA_FILE],
    resets: 'local midnight',
    source: budget.source,
    note: "This app's own count in runtime/quota.json, shared with the engine room. Google's real limit differs by model; check AI Studio.",
  };
}

// ── The voice's own budget ──────────────────────────────────────────────────
export function resolveVoiceBudget(): BudgetInfo {
  const raw = (process.env.SUPPER_GEMINI_VOICE_BUDGET || '').trim();
  if (!raw) return { limit: DEFAULT_VOICE_BUDGET, source: `the app's default (${DEFAULT_VOICE_BUDGET} spoken sentences a day)` };
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    return { limit: DEFAULT_VOICE_BUDGET, source: `the app's default (${DEFAULT_VOICE_BUDGET}) — SUPPER_GEMINI_VOICE_BUDGET could not be read` };
  }
  return { limit: value, source: 'SUPPER_GEMINI_VOICE_BUDGET' };
}

export function voiceQuotaSnapshot(): QuotaSnapshot {
  const budget = resolveVoiceBudget();
  const counter = readCounter(VOICE_QUOTA_FILE);
  return {
    day: counter.day,
    used: counter.used,
    limit: budget.limit,
    remaining: counter.unreadable ? 0 : Math.max(0, budget.limit - counter.used),
    enabled: budget.limit > 0,
    unreadable: counter.unreadable,
    saved: !saveFailed[VOICE_QUOTA_FILE],
    resets: 'local midnight',
    source: budget.source,
    note: "The voice's own count in runtime/voice_quota.json — kept apart from the brain's budget so speaking can never starve the thinking.",
  };
}

/** One unit for one spoken sentence generated on the server. */
export function trySpendVoiceBudget(): { allowed: boolean; snapshot: QuotaSnapshot } {
  const budget = resolveVoiceBudget();
  const counter = readCounter(VOICE_QUOTA_FILE);
  if (counter.unreadable || budget.limit === 0 || counter.used >= budget.limit) {
    return { allowed: false, snapshot: voiceQuotaSnapshot() };
  }
  writeCounter(counter.day, counter.used + 1, VOICE_QUOTA_FILE);
  return { allowed: true, snapshot: voiceQuotaSnapshot() };
}

/**
 * Take one unit for a call that is about to reach Gemini. Failed calls count
 * too, exactly as backend/quota.py counts them. The read-modify-write plus the
 * atomic rename keeps concurrent writes safe (see docs/CONFIG_SOURCE_OF_TRUTH.md
 * for the one honest limitation when both builds run at once).
 */
export function trySpendGeminiBudget(): { allowed: boolean; snapshot: QuotaSnapshot } {
  const budget = resolveDailyBudget();
  const counter = readCounter();
  if (counter.unreadable || budget.limit === 0 || counter.used >= budget.limit) {
    return { allowed: false, snapshot: quotaSnapshot() };
  }
  const used = counter.used + 1;
  writeCounter(counter.day, used);
  return { allowed: true, snapshot: quotaSnapshot() };
}

/** Google reported its own limit is reached: no more calls today. */
export function markBudgetExhausted(): void {
  const budget = resolveDailyBudget();
  if (budget.limit <= 0) return;
  const counter = readCounter();
  if (counter.unreadable) return;           // never overwrite a counter we could not read
  writeCounter(counter.day, budget.limit);
}

/**
 * Google refused a SPOKEN sentence because its own limit is reached.
 *
 * The two budgets are counted apart on purpose (see the note on
 * VOICE_QUOTA_FILE): twenty spoken sentences a day and no answers left would
 * be the result of sharing one counter. So a refused sentence may only close
 * the voice's own counter — never the brain's. Marking the text budget here
 * switched the answers off for the rest of the day because the MOUTH was
 * refused, which is exactly the confusion the split exists to prevent.
 */
export function markVoiceBudgetExhausted(): void {
  const budget = resolveVoiceBudget();
  if (budget.limit <= 0) return;
  const counter = readCounter(VOICE_QUOTA_FILE);
  if (counter.unreadable) return;           // never overwrite a counter we could not read
  writeCounter(counter.day, budget.limit, VOICE_QUOTA_FILE);
}

// ── The brain: one call path, honest failures ───────────────────────────────
export interface GeminiRaw {
  text?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> } }>;
  /**
   * What the model name ACTUALLY resolved to. `gemini-flash-latest` is a moving
   * alias: the owner is told "flash-latest" while Google quietly moves it from
   * one generation to the next, and that is the only way to end up on the wrong
   * Gemini version without anything ever changing in this repository. Google
   * returns the concrete version here, so the app can name it.
   */
  modelVersion?: string;
}

export interface BrainCaller {
  generate(model: string, contents: unknown[], config?: Record<string, unknown>): Promise<GeminiRaw>;
  /**
   * The same call, answered in pieces. Every yielded string is the next slice of
   * the reply, already decoded, so the page can show — and speak — the first
   * sentence while the rest is still being written. Optional: a caller without
   * it simply uses generate() and the reply arrives in one piece.
   */
  generateStream?(model: string, contents: unknown[], config?: Record<string, unknown>): AsyncIterable<string>;
  listModels(): Promise<string[]>;
}

/**
 * ── SPEED: the settings that make a reply arrive in a second, not ten ────────
 *
 * Gemini *thinks* before it answers unless it is told not to. That thinking is
 * invisible in the reply and costs several seconds of waiting on every single
 * command — the owner hears silence, then a paragraph. For a voice assistant the
 * answer is worth more than the deliberation, so thinking is turned down and
 * the answer length is capped, because a capped answer is written sooner and
 * spoken sooner.
 *
 * ── WHICH PARAMETER? THIS IS WHERE THE GENERATION MATTERS ────────────────────
 * The two generations do NOT take the same setting, and sending the wrong one
 * costs a failed round trip on every single reply:
 *
 *   Gemini 2.x  -> thinkingConfig: { thinkingBudget: 0 }
 *   Gemini 3.x  -> thinkingConfig: { thinkingLevel: 'LOW' }
 *
 * Google deprecated thinking_budget for Gemini 3 (it answers
 * 400 INVALID_ARGUMENT); Gemini 3.8 Flash documents "tunable thinking levels
 * (low, medium, high)". This app used to send the 2.5 parameter while
 * gemini-flash-latest was already serving a Gemini 3 model — the definition of
 * talking to one generation with another generation's settings.
 *
 * The generation is read from the model NAME, and when a name gives nothing
 * away (a moving alias) the app assumes the current generation. Whichever
 * guess is wrong, the ladder in thinkingModes() tries the other one, then no
 * thinking setting at all — see isConfigRejection() — and remembers which one
 * worked, so the mistake is never paid for twice.
 */
export const SPEED_MAX_OUTPUT_TOKENS = 900;

/** How to ask a model to keep its thinking short. */
export type ThinkingMode = 'level' | 'budget' | 'none';

/** Only these older generations take a numeric thinking budget. */
const BUDGET_ERA = /(?:^|[^a-z0-9])(?:1\.5|2\.0|2\.5)(?:[^a-z0-9]|$)|embedding|aqa|gemma|learnlm/;

/** Which thinking parameter this model's generation understands. */
export function preferredThinkingMode(model: string): ThinkingMode {
  const id = String(model || '').toLowerCase();
  if (!id) return 'none';
  if (BUDGET_ERA.test(id)) return 'budget';
  // Gemini 3 and later — and any moving alias, which is a 3-era model today.
  return 'level';
}

export function speedConfig(model: string, mode: ThinkingMode = preferredThinkingMode(model)): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    maxOutputTokens: SPEED_MAX_OUTPUT_TOKENS,
    temperature: 0.7,
  };
  if (mode === 'level') cfg.thinkingConfig = { thinkingLevel: 'LOW' };
  else if (mode === 'budget') cfg.thinkingConfig = { thinkingBudget: 0 };
  return cfg;
}

/**
 * The order to try the thinking settings in: what worked last time for this
 * model first, then the generation's own parameter, then the other one, then
 * none. Remembering means a model that answers is answered the same way next
 * time instead of paying for a refused request on every reply.
 */
export function thinkingModes(model: string): ThinkingMode[] {
  const remembered = readThinkingMemory()[String(model || '')]?.mode;
  const order: ThinkingMode[] = [];
  const push = (mode: ThinkingMode) => { if (!order.includes(mode)) order.push(mode); };
  if (remembered) push(remembered);
  push(preferredThinkingMode(model));
  push('budget');
  push('level');
  push('none');
  return order;
}

/** What last worked, per model, in runtime/dashboard_models.json. */
function readThinkingMemory(): Record<string, { mode: ThinkingMode; at: string }> {
  const raw = readJsonSafe(MODEL_MEMORY_FILE) as Record<string, unknown> | null;
  const section = (raw && raw['thinking']) as Record<string, unknown> | undefined;
  const out: Record<string, { mode: ThinkingMode; at: string }> = {};
  if (section && typeof section === 'object') {
    for (const [model, entry] of Object.entries(section)) {
      const mode = (entry as { mode?: unknown })?.mode;
      if (mode === 'level' || mode === 'budget' || mode === 'none') {
        out[model] = { mode, at: String((entry as { at?: unknown })?.at ?? '') };
      }
    }
  }
  return out;
}

export function rememberThinkingMode(model: string, mode: ThinkingMode): void {
  if (!model || !mode) return;
  try {
    const file = (readJsonSafe(MODEL_MEMORY_FILE) || {}) as Record<string, unknown>;
    const section = (file['thinking'] && typeof file['thinking'] === 'object')
      ? file['thinking'] as Record<string, unknown>
      : {};
    section[model] = { mode, at: new Date().toISOString() };
    file['thinking'] = section;
    writeFileAtomic(MODEL_MEMORY_FILE, JSON.stringify(file, null, 2));
  } catch (err) {
    console.warn('[config] could not remember the working thinking setting:', err);
  }
}

/** True when a failure is the model refusing a generation setting, not the model. */
export function isConfigRejection(raw: string): boolean {
  return /thinkingconfig|thinking_config|thinkingbudget|thinking budget|thinkinglevel|thinking level|thinking_level|invalid[_ ]argument|invalid json payload|unknown name|unsupported field|cannot be set/i.test(String(raw || ''));
}

export type BrainFailureCode =
  | 'no-key' | 'budget' | 'model-unavailable' | 'key-rejected'
  | 'rate-limited' | 'connection' | 'empty' | 'failed';

export interface AttemptReport { model: string; source: string; ok: boolean; status?: number; error?: string; }

export class BrainError extends Error {
  code: BrainFailureCode;
  attempts: AttemptReport[];
  model: string;
  modelSource: string;
  constructor(message: string, code: BrainFailureCode, attempts: AttemptReport[], model: string, modelSource: string) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
    this.attempts = attempts;
    this.model = model;
    this.modelSource = modelSource;
  }
}

export interface ClassifiedError { code: BrainFailureCode; status?: number; raw: string; }

/**
 * Read a Gemini failure for what it really is. A 404/NOT_FOUND is the model
 * name being withdrawn — the key is fine, and saying otherwise sends the owner
 * hunting in the wrong place.
 */
export function classifyGeminiError(err: unknown): ClassifiedError {
  const asRecord = (err || {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof asRecord.status === 'number' ? asRecord.status
    : typeof asRecord.status === 'string' && /^\d+$/.test(asRecord.status) ? Number(asRecord.status) : undefined;
  const raw = err instanceof Error ? err.message : String(asRecord.message || err || 'unknown error');
  const text = raw.toLowerCase();

  if (status === 404 || /not_found|not found|no longer available|is not supported|does not exist|unknown model|not supported for/.test(text)) {
    return { code: 'model-unavailable', status, raw };
  }
  const keySpecificFailure =
    /api[ _-]?key[ _-]?invalid|api_key_invalid|unauthenticated|invalid api key|incorrect api key|key is invalid|key not valid|api[ _-]?key.*(?:not authorized|permission|denied)/.test(text);
  if (status === 401 || keySpecificFailure) {
    return { code: 'key-rejected', status, raw };
  }
  // Google can return 403 when an otherwise-valid key is not allowed to use a
  // particular model (for example, restricted Gemini 2.5 access). Try the
  // current stable model for an explicitly model-scoped denial. Generic 403s
  // still indicate a key/project permission problem and must not be hidden.
  const modelScopedDenial =
    /\b(?:model|models\/|gemini[-\w.]+)\b/.test(text) &&
    /\b(?:permission|access denied|not authorized|not allowed|restricted|unavailable)\b/.test(text);
  if (status === 403 && modelScopedDenial) {
    return { code: 'model-unavailable', status, raw };
  }
  if (status === 403 || /permission denied/.test(text)) {
    return { code: 'key-rejected', status, raw };
  }
  if (status === 429 || /resource_exhausted|quota|rate limit|too many requests/.test(text)) {
    return { code: 'rate-limited', status, raw };
  }
  if (/enotfound|econnrefused|econnreset|etimedout|eai_again|socket hang up|fetch failed|network|getaddrinfo|timed out|aborted/.test(text)) {
    return { code: 'connection', status, raw };
  }
  return { code: 'failed', status, raw };
}

function trimRaw(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export interface FailureContext {
  code: BrainFailureCode;
  model: string;
  modelSource: string;
  key: KeyInfo;
  raw?: string;
  attempts: AttemptReport[];
}

export function explainBrainFailure(ctx: FailureContext): string {
  const { key } = ctx;
  switch (ctx.code) {
    case 'no-key':
      return `I have no Gemini key, sir. ${key.detail}. Add "gemini_api_key" to config/api_keys.json (Settings → "The Brain" writes it there), or set GEMINI_API_KEY — either is read at once, no restart.`;
    case 'budget': {
      const snapshot = quotaSnapshot();
      const why = snapshot.unreadable
        ? `runtime/quota.json exists but I cannot read it, so the budget stays closed until local midnight (the app fails closed on a damaged counter)`
        : `the day's budget is used: ${snapshot.used} of ${snapshot.limit} calls (${snapshot.source})`;
      return `I am not calling Gemini, sir: ${why}. The count is in runtime/quota.json and resets at local midnight. Raise SUPPER_GEMINI_DAILY_BUDGET if the day needs more.`;
    }
    case 'model-unavailable': {
      const tried = ctx.attempts.filter((a) => a.error).map((a) => a.model).join(', ') || ctx.model;
      return `The model name was withdrawn, sir — my key is fine, so do not change it. Google answered 404 NOT_FOUND for ${tried}.` +
        ` Set SUPPER_TEXT_MODEL (or GEMINI_MODEL) to a current model, or clear both and I fall back to the app's moving alias ${DEFAULT_TEXT_MODEL}.` +
        (ctx.raw ? ` Google said: ${trimRaw(ctx.raw)}` : '');
    }
    case 'key-rejected':
      return `Google refused the key itself (${key.source || 'no source'}; ending in …${key.tail ?? '????'}), which comes from ${key.detail} — the key is the problem here, not the model (${ctx.model}).` +
        ` Paste a working key in Settings → "The Brain".` + (ctx.raw ? ` Google said: ${trimRaw(ctx.raw)}` : '');
    case 'rate-limited':
      return `Google says the quota is used up (429) for ${ctx.model}. The day's count in runtime/quota.json is now marked used up; it resets at local midnight` +
        ` (Google's own daily quota resets at midnight Pacific). Neither the key nor the model name is at fault.` +
        (ctx.raw ? ` Google said: ${trimRaw(ctx.raw)}` : '');
    case 'connection':
      return `The call never reached Google, sir — a connection problem, so neither the key (${key.source || 'none'}) nor the model (${ctx.model}) is at fault.` +
        ` The key is fine; check the internet connection or a proxy, then try again.` + (ctx.raw ? ` The error was: ${trimRaw(ctx.raw)}` : '');
    case 'empty':
      return `I reached ${ctx.model}, sir, but it sent back nothing I can use. The model name is accepted and the key works; try again, and if it repeats check that this model can answer text.`;
    default:
      return `The call to Gemini failed for a reason I cannot classify (model ${ctx.model}, key from ${key.source || 'none'}): ${trimRaw(ctx.raw || 'no detail')}.`;
  }
}

/**
 * Run one Gemini task through the configured model, then the remembered one,
 * and only then — as a last resort — whatever the key's own model list offers.
 * Every attempt that reaches Gemini takes one unit of the day's budget.
 */
export interface BrainRun<T> {
  value: T;
  model: string;
  modelSource: string;
  /** The concrete version the model NAME resolved to, when Google reports one. */
  modelVersion?: string;
  attempts: AttemptReport[];
}

export interface BrainRunOptions<T> {
  kind: 'text' | 'image';
  contents: unknown[];
  config?: Record<string, unknown>;
  extract: (raw: GeminiRaw) => T | null;
  /** Tests inject their own queue and their own budget; production uses the defaults. */
  candidates?: ModelCandidate[];
  spend?: () => { allowed: boolean; snapshot: QuotaSnapshot };
  /** Set false in tests that must not touch the network for discovery. */
  allowDiscovery?: boolean;
  /** Set false to send only the caller's own settings — never the speed defaults. */
  speed?: boolean;
}

export async function runBrain<T>(caller: BrainCaller | null, opts: BrainRunOptions<T>): Promise<BrainRun<T>> {
  const key = resolveGeminiKey();
  if (!caller || !key.key) {
    throw new BrainError(explainBrainFailure({ code: 'no-key', model: '', modelSource: '', key, attempts: [] }), 'no-key', [], '', '');
  }

  let candidates: ModelCandidate[] = (opts.candidates || modelCandidates(opts.kind)).slice();
  const attempted = new Set<string>();
  const attempts: AttemptReport[] = [];
  const spend = opts.spend || trySpendGeminiBudget;
  let discoveryDone = opts.allowDiscovery === false;
  let lastModel = candidates[0]?.model || '';
  let lastSource = candidates[0]?.source || '';
  let lastReport: ClassifiedError = { code: 'failed', raw: 'no model was tried' };

  for (;;) {
    const next = candidates.find((c) => c.model && !attempted.has(c.model));
    if (!next) {
      if (!discoveryDone) {
        discoveryDone = true;
        try {
          const found = await discoverModels(caller, opts.kind);
          const fresh = found.filter((c) => !attempted.has(c.model));
          if (fresh.length) {
            candidates = candidates.concat(fresh);
            continue;
          }
        } catch (err) {
          console.warn('[config] model discovery failed (that is allowed — it is only a last resort):', err instanceof Error ? err.message : err);
        }
      }
      break;
    }

    attempted.add(next.model);
    lastModel = next.model;
    lastSource = next.source;

    const budget = spend();
    if (!budget.allowed) {
      throw new BrainError(explainBrainFailure({ code: 'budget', model: next.model, modelSource: next.source, key, attempts }), 'budget', attempts, next.model, next.source);
    }

    // The speed settings ride along with every text call: thinking off where the
    // model takes that setting, and a capped answer. See speedConfig().
    const usedSpeed = opts.speed !== false && opts.kind === 'text';
    type Outcome = { raw?: GeminiRaw; error?: ClassifiedError };
    const attempt = async (cfg: Record<string, unknown> | undefined): Promise<Outcome> => {
      try {
        return { raw: await caller.generate(next.model, opts.contents, cfg) };
      } catch (err) {
        return { error: classifyGeminiError(err) };
      }
    };

    // Walk the thinking settings and STOP at the first one this model accepts.
    // Whichever one works is remembered, so the next reply does not pay for the
    // same refused request again.
    const ladder: Array<ThinkingMode | null> = usedSpeed ? [...thinkingModes(next.model), null] : [null];
    let outcome: Outcome = { error: classifyGeminiError('no model was called') };
    let usedMode: ThinkingMode | null = null;
    for (const mode of ladder) {
      const cfg = mode === null ? opts.config : { ...speedConfig(next.model, mode), ...(opts.config || {}) };
      outcome = await attempt(cfg);
      usedMode = mode;
      if (!outcome.error) break;
      // A setting was refused, not the model: try the next setting so a model
      // that does not take this one still answers.
      if (mode === null || !isConfigRejection(outcome.error.raw)) break;
      console.warn(`[config] ${opts.kind} call to ${next.model} refused the ${mode} thinking setting (${trimRaw(outcome.error.raw)}) — trying another.`);
    }
    if (outcome.raw && usedMode) rememberThinkingMode(next.model, usedMode);

    if (outcome.raw) {
      if (outcome.raw.modelVersion && outcome.raw.modelVersion !== next.model) {
        console.log(`[JARVIS] ${next.model} is being served as ${outcome.raw.modelVersion} — that is the version actually answering.`);
      }
      const value = opts.extract(outcome.raw);
      if (value === null || value === undefined) {
        attempts.push({ model: next.model, source: next.source, ok: false, error: 'empty reply' });
        lastReport = { code: 'empty', raw: 'empty reply' };
        continue;
      }
      if (readRememberedModel(opts.kind) !== next.model) rememberModel(opts.kind, next.model);
      attempts.push({ model: next.model, source: next.source, ok: true });
      return { value, model: next.model, modelSource: next.source, modelVersion: outcome.raw.modelVersion, attempts };
    }

    {
      const classified = outcome.error as ClassifiedError;
      lastReport = classified;
      attempts.push({ model: next.model, source: next.source, ok: false, status: classified.status, error: trimRaw(classified.raw) });
      console.warn(`[config] ${opts.kind} call to ${next.model} failed (${classified.code}${classified.status ? ` ${classified.status}` : ''}): ${trimRaw(classified.raw)}`);

      if (classified.code === 'rate-limited') {
        markBudgetExhausted();
        throw new BrainError(explainBrainFailure({ code: 'rate-limited', model: next.model, modelSource: next.source, key, raw: classified.raw, attempts }), 'rate-limited', attempts, next.model, next.source);
      }
      if (classified.code === 'key-rejected' || classified.code === 'connection') {
        // Another model cannot mend a rejected key or a dead connection.
        throw new BrainError(explainBrainFailure({ code: classified.code, model: next.model, modelSource: next.source, key, raw: classified.raw, attempts }), classified.code, attempts, next.model, next.source);
      }
      // A withdrawn name, model-scoped access denial, or unexplained failure: forget it and try the next candidate.
      forgetModel(opts.kind, next.model);
    }
  }

  if (!attempts.length) {
    const setting = opts.kind === 'image' ? 'SUPPER_IMAGE_MODEL' : 'SUPPER_TEXT_MODEL';
    throw new BrainError(
      `I could not find a model to use, sir: nothing is configured and your key's own model list offered nothing suitable for ${opts.kind === 'image' ? 'pictures' : 'text'}. ` +
      `Set ${setting} to a model your key may use (the key itself is fine — it came from ${key.detail}).`,
      'model-unavailable', attempts, '', '',
    );
  }
  const code: BrainFailureCode = lastReport.code === 'failed' ? 'failed' : lastReport.code;
  throw new BrainError(
    explainBrainFailure({ code, model: lastModel, modelSource: lastSource, key, raw: lastReport.raw, attempts }),
    code, attempts, lastModel, lastSource,
  );
}

// ── Streaming: the same walk over the models, but answered in pieces ────────
// The page shows — and speaks — the first sentence while the rest is still being
// written, which is what makes a reply feel instant. The fallback rules are the
// ones runBrain() uses: a model that fails before its first word is replaced by
// the next candidate; a model that fails mid-answer keeps the words it managed
// to say rather than throwing them away.
export interface BrainStreamRun {
  value: string;
  model: string;
  modelSource: string;
  /** The concrete version the model NAME resolved to, when Google reports one. */
  modelVersion?: string;
  attempts: AttemptReport[];
  /** True when the reply arrived in pieces (the answer can be spoken as written). */
  streamed: boolean;
}

export interface BrainStreamOptions {
  kind: 'text' | 'image';
  contents: unknown[];
  config?: Record<string, unknown>;
  /** Called with the whole answer so far, every time more of it exists. */
  onDelta?: (textSoFar: string) => void;
  candidates?: ModelCandidate[];
  spend?: () => { allowed: boolean; snapshot: QuotaSnapshot };
  allowDiscovery?: boolean;
  speed?: boolean;
}

export async function runBrainStream(caller: BrainCaller | null, opts: BrainStreamOptions): Promise<BrainStreamRun> {
  const key = resolveGeminiKey();
  if (!caller || !key.key) {
    throw new BrainError(explainBrainFailure({ code: 'no-key', model: '', modelSource: '', key, attempts: [] }), 'no-key', [], '', '');
  }

  const allowDiscovery = opts.allowDiscovery !== false;
  const extractText = (raw: GeminiRaw): string | null =>
    (typeof raw.text === 'string' && raw.text.trim() ? raw.text.trim() : null);

  let candidates: ModelCandidate[] = (opts.candidates || modelCandidates(opts.kind)).slice();
  const attempted = new Set<string>();
  const attempts: AttemptReport[] = [];
  const spend = opts.spend || trySpendGeminiBudget;
  let discoveryDone = !allowDiscovery;
  let lastModel = candidates[0]?.model || '';
  let lastSource = candidates[0]?.source || '';
  let lastReport: ClassifiedError = { code: 'failed', raw: 'no model was tried' };

  for (;;) {
    const next = candidates.find((c) => c.model && !attempted.has(c.model));
    if (!next) {
      if (!discoveryDone) {
        discoveryDone = true;
        try {
          const found = await discoverModels(caller, opts.kind);
          const fresh = found.filter((c) => !attempted.has(c.model));
          if (fresh.length) { candidates = candidates.concat(fresh); continue; }
        } catch (err) {
          console.warn('[config] model discovery failed (that is allowed — it is only a last resort):', err instanceof Error ? err.message : err);
        }
      }
      break;
    }

    attempted.add(next.model);
    lastModel = next.model;
    lastSource = next.source;

    const budget = spend();
    if (!budget.allowed) {
      throw new BrainError(explainBrainFailure({ code: 'budget', model: next.model, modelSource: next.source, key, attempts }), 'budget', attempts, next.model, next.source);
    }

    const usedSpeed = opts.speed !== false && opts.kind === 'text';
    const ladder: Array<ThinkingMode | null> = usedSpeed ? [...thinkingModes(next.model), null] : [null];
    const cfgFor = (mode: ThinkingMode | null) => (mode === null
      ? opts.config
      : { ...speedConfig(next.model, mode), ...(opts.config || {}) });

    let text = '';
    let failure: ClassifiedError | null = null;
    let streamed = false;
    /** The concrete version Google served under this model NAME, when it says. */
    let lastModelVersion = '';
    let usedMode: ThinkingMode | null = null;

    const consume = async (stream: AsyncIterable<string>) => {
      for await (const piece of stream) {
        if (typeof piece !== 'string' || !piece) continue;
        if (!streamed) streamed = true;
        text += piece;
        if (opts.onDelta) opts.onDelta(text);
      }
    };

    // Same ladder as runBrain(): stop at the thinking setting this model
    // accepts, and remember it so the next reply never pays for a refusal.
    for (const mode of ladder) {
      usedMode = mode;
      failure = null;
      text = '';
      streamed = false;

      if (typeof caller.generateStream === 'function') {
        try {
          await consume(caller.generateStream(next.model, opts.contents, cfgFor(mode)));
        } catch (err) {
          failure = classifyGeminiError(err);
        }
      }

      // Some endpoints answer a streaming request with nothing at all (an old
      // proxy, or a server that only speaks generateContent). Ask once the
      // ordinary way rather than pretending the model is broken.
      if (!text && !failure) {
        try {
          const raw = await caller.generate(next.model, opts.contents, cfgFor(mode));
          lastModelVersion = raw.modelVersion || lastModelVersion;
          const value = extractText(raw);
          if (value) { text = value; if (opts.onDelta) opts.onDelta(text); }
          else lastReport = { code: 'empty', raw: 'empty reply' };
        } catch (err) {
          failure = classifyGeminiError(err);
        }
      }

      if (!failure) break;
      if (mode === null || !isConfigRejection(failure.raw)) break;
      console.warn(`[config] streaming call to ${next.model} refused the ${mode} thinking setting (${trimRaw(failure.raw)}) — trying another.`);
    }
    if (!failure && usedMode) rememberThinkingMode(next.model, usedMode);

    if (text) {
      if (failure) {
        // The words that arrived are real; keep them and say so in the log.
        console.warn(`[config] the stream from ${next.model} broke after ${text.length} characters (${failure.code}): ${trimRaw(failure.raw)}`);
      }
      if (lastModelVersion) {
        console.log(`[JARVIS] ${next.model} is being served as ${lastModelVersion} — that is the version actually answering.`);
      }
      if (readRememberedModel(opts.kind) !== next.model) rememberModel(opts.kind, next.model);
      attempts.push({ model: next.model, source: next.source, ok: true, error: failure ? `cut short: ${trimRaw(failure.raw)}` : undefined });
      return { value: text, model: next.model, modelSource: next.source, modelVersion: lastModelVersion || undefined, attempts, streamed };
    }

    if (!failure) {
      attempts.push({ model: next.model, source: next.source, ok: false, error: 'empty reply' });
      lastReport = { code: 'empty', raw: 'empty reply' };
      continue;
    }

    lastReport = failure;
    attempts.push({ model: next.model, source: next.source, ok: false, status: failure.status, error: trimRaw(failure.raw) });
    console.warn(`[config] ${opts.kind} call to ${next.model} failed (${failure.code}${failure.status ? ` ${failure.status}` : ''}): ${trimRaw(failure.raw)}`);
    if (failure.code === 'rate-limited') {
      markBudgetExhausted();
      throw new BrainError(explainBrainFailure({ code: 'rate-limited', model: next.model, modelSource: next.source, key, raw: failure.raw, attempts }), 'rate-limited', attempts, next.model, next.source);
    }
    if (failure.code === 'key-rejected' || failure.code === 'connection') {
      throw new BrainError(explainBrainFailure({ code: failure.code, model: next.model, modelSource: next.source, key, raw: failure.raw, attempts }), failure.code, attempts, next.model, next.source);
    }
    forgetModel(opts.kind, next.model);
  }

  if (!attempts.length) {
    const setting = opts.kind === 'image' ? 'SUPPER_IMAGE_MODEL' : 'SUPPER_TEXT_MODEL';
    throw new BrainError(
      `I could not find a model to use, sir: nothing is configured and your key's own model list offered nothing suitable for ${opts.kind === 'image' ? 'pictures' : 'text'}. ` +
      `Set ${setting} to a model your key may use (the key itself is fine — it came from ${key.detail}).`,
      'model-unavailable', attempts, '', '',
    );
  }
  const code: BrainFailureCode = lastReport.code === 'failed' ? 'failed' : lastReport.code;
  throw new BrainError(
    explainBrainFailure({ code, model: lastModel, modelSource: lastSource, key, raw: lastReport.raw, attempts }),
    code, attempts, lastModel, lastSource,
  );
}

// ── Brain check: one real call, with the model named ────────────────────────
export interface BrainCheckResult {
  ok: boolean;
  model: string;
  modelSource: string;
  /**
   * The concrete version the model NAME resolved to. `gemini-flash-latest` is a
   * moving alias — it printed the same string while Google moved it from 2.5 to
   * 3 to 3.5 underneath, which is how this app can end up talking to a
   * different Gemini generation without a line of code changing. This is the
   * version that actually answered, straight from Google.
   */
  modelVersion?: string;
  keySource: KeySource;
  keyTail: string | null;
  keyDetail: string;
  latencyMs: number;
  reply: string | null;
  attempts: AttemptReport[];
  quota: QuotaSnapshot;
  minutesToNextModel?: string;
  error?: string;
  code?: BrainFailureCode;
  checkedAt: string;
}

export async function brainCheck(caller: BrainCaller | null): Promise<BrainCheckResult> {
  const key = resolveGeminiKey();
  const started = Date.now();
  const base = {
    model: resolveTextModel().model,
    modelSource: resolveTextModel().source,
    keySource: key.source,
    keyTail: key.tail,
    keyDetail: key.detail,
    quota: quotaSnapshot(),
    checkedAt: new Date().toISOString(),
  };
  try {
    const run = await runBrain<string>(caller, {
      kind: 'text',
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly these three words: brain check ok' }] }],
      extract: (raw) => (typeof raw.text === 'string' && raw.text.trim() ? raw.text.trim() : null),
    });
    const textModel = resolveTextModel();
    return {
      ok: true, reply: run.value, model: run.model, modelSource: run.modelSource, modelVersion: run.modelVersion,
      keySource: key.source, keyTail: key.tail, keyDetail: key.detail,
      latencyMs: Date.now() - started, attempts: run.attempts,
      quota: quotaSnapshot(),
      minutesToNextModel: run.model === textModel.model ? undefined : `served by ${run.model} while ${textModel.model} is unavailable`,
      checkedAt: base.checkedAt,
    };
  } catch (err) {
    const brainError = err instanceof BrainError ? err : null;
    return {
      ok: false,
      model: brainError?.model || base.model,
      modelSource: brainError?.modelSource || base.modelSource,
      keySource: key.source, keyTail: key.tail, keyDetail: key.detail,
      latencyMs: Date.now() - started,
      reply: null,
      attempts: brainError?.attempts || [],
      quota: quotaSnapshot(),
      error: err instanceof Error ? err.message : String(err),
      code: brainError?.code,
      checkedAt: base.checkedAt,
    };
  }
}

// ── Saving the key where the app actually reads it ──────────────────────────
export interface SaveKeyResult { savedTo: string[]; source: KeySource; detail: string; }

export function saveGeminiKey(key: string): SaveKeyResult {
  const cleaned = key.trim();
  if (cleaned.length < 10) throw new Error('That does not look like a Gemini API key — it needs at least 10 characters.');

  // 1. The app's own settings file. Other settings in it are preserved; a file
  //    that exists but cannot be parsed is never overwritten (the owner may
  //    have hand-edited it).
  const savedTo: string[] = [];
  const existing = fs.existsSync(API_CONFIG_PATH) ? fs.readFileSync(API_CONFIG_PATH, 'utf-8') : '';
  let file: Record<string, unknown> = {};
  if (existing.trim()) {
    const parsed = readJsonSafe(API_CONFIG_PATH);
    if (!parsed) throw new Error(`${API_CONFIG_PATH} exists but is not valid JSON — I will not overwrite it. Fix or move that file, then save again.`);
    file = parsed;
  }
  file['gemini_api_key'] = cleaned;
  writeFileAtomic(API_CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
  savedTo.push('config/api_keys.json');

  // 2. If ./.env holds a GEMINI_API_KEY line it shadows the file (the
  //    environment is read first), so it is brought along — the key the owner
  //    just typed is then the key in force.
  if (fs.existsSync(ENV_FILE) && envFileKey()) {
    const lines = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/);
    let replaced = false;
    const out = lines.map((line) => {
      if (/^\s*(?:export\s+)?GEMINI_API_KEY\s*=/.test(line)) {
        replaced = true;
        return `GEMINI_API_KEY=${cleaned}`;
      }
      return line;
    });
    if (replaced) {
      writeFileAtomic(ENV_FILE, out.join('\n'));
      savedTo.push('.env');
      if (!KEY_FROM_SHELL) process.env.GEMINI_API_KEY = cleaned;   // live at once
    }
  }

  const info = resolveGeminiKey();
  const shellNote = KEY_FROM_SHELL
    ? ' The environment already carried GEMINI_API_KEY before ./.env was read (the shell or the launcher), and the environment is read first — clear that variable for the saved key to take over.'
    : '';
  return {
    savedTo,
    source: info.source,
    detail: `written to ${savedTo.join(' and ')}; in force now: ${info.detail}.${shellNote}`,
  };
}

// ── The status the Settings pane and the diagnostics print ──────────────────
export interface ConfigStatus {
  key: ReturnType<typeof publicKeyInfo>;
  model: { text: string; textSource: string; image: string; imageSource: string };
  names: NameInfo;
  quota: QuotaSnapshot;
}

export function configStatus(): ConfigStatus {
  const key = resolveGeminiKey();
  const text = resolveTextModel();
  const image = resolveImageModel();
  return {
    key: publicKeyInfo(key),
    model: { text: text.model, textSource: text.source, image: image.model, imageSource: image.source },
    names: resolveNames(),
    quota: quotaSnapshot(),
  };
}
