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
 *   KEY 2  GEMINI_API_KEY_2 (the environment, including ./.env)
 *          then config/api_keys.json -> "gemini_api_key_2"
 *          The optional FALLBACK key. Every call goes out on the first key;
 *          when Google refuses the first key with a 429 (its quota) or rejects
 *          the key itself, the second key takes over for the rest of the local
 *          day. It only doubles the real allowance if it belongs to a
 *          different Google account/project.
 *
 *   COUNT  The app COUNTS and WARNS; it never BLOCKS. Every outbound question
 *          adds one unit to runtime/quota.json (total and per key), reset at
 *          local midnight. Past SUPPER_GEMINI_DAILY_WARN (default 20) the
 *          terminal and Settings warn — the call still goes through. The only
 *          thing that stops calls is Google itself: a real 429 marks THAT key
 *          as stopped by Google until local midnight. When every key we have
 *          is stopped, calls are refused with a message that says Google did
 *          it, not this app. A counter file that cannot be read never blocks
 *          either: the count continues in memory and Settings says the file
 *          could not be read. (The old SUPPER_GEMINI_DAILY_BUDGET block is
 *          gone; if that setting is still present it is read as the warning
 *          level.) The file keeps the {day, used} shape the engine room
 *          reads, with the per-key detail beside it.
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
/**
 * The default WARNING level for the day's count of outbound Gemini calls. It is
 * only a warning: the count never blocks a call. (It used to be the hard limit,
 * SUPPER_GEMINI_DAILY_BUDGET = 20, which refused calls Google would still have
 * answered.)
 */
export const DEFAULT_DAILY_WARN = 20;
export const DEFAULT_VOICE_BUDGET = 400;          // spoken sentences a day

// The keys may already be in the shell. Note that before dotenv runs, so the
// dashboard can say honestly whether a key came from the shell or from ./.env.
const KEY_FROM_SHELL = Boolean((process.env.GEMINI_API_KEY || '').trim());
const KEY2_FROM_SHELL = Boolean((process.env.GEMINI_API_KEY_2 || '').trim());
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

/** Which of the two Gemini keys: 1 is the normal one, 2 the optional fallback. */
export type KeySlot = 1 | 2;

/** The names each key slot goes by in the environment and in config/api_keys.json. */
function slotNames(slot: KeySlot): { env: string; field: string; label: string } {
  return slot === 2
    ? { env: 'GEMINI_API_KEY_2', field: 'gemini_api_key_2', label: 'the second key (fallback)' }
    : { env: 'GEMINI_API_KEY', field: 'gemini_api_key', label: 'the first key' };
}

function envFileKey(slot: KeySlot = 1): string {
  const { env } = slotNames(slot);
  try {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${env}\\s*=`);
    const line = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/).find((l) => pattern.test(l));
    if (!line) return '';
    return line.replace(new RegExp(`^\\s*(?:export\\s+)?${env}\\s*=\\s*`), '').trim().replace(/^["']|["']$/g, '');
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
  /** Which slot this is: 1 the normal key, 2 the fallback. */
  slot: KeySlot;
}

/**
 * Resolve one key slot the honest way: the environment first (the shell, the
 * launcher, or ./.env), then config/api_keys.json. Both slots follow the same
 * order, so an old GEMINI_API_KEY_2 in the environment shadows a saved second
 * key exactly as GEMINI_API_KEY shadows the first — and is reported as such.
 */
export function resolveKeySlot(slot: KeySlot): KeyInfo {
  const names = slotNames(slot);
  const fromShell = slot === 2 ? KEY2_FROM_SHELL : KEY_FROM_SHELL;
  const env = (process.env[names.env] || '').trim();
  if (env) {
    const fromFile = envFileKey(slot);
    const fromEnvFile = !fromShell && fromFile === env;
    const source: KeySource = fromEnvFile ? '.env' : 'environment';
    return {
      key: env,
      source,
      tail: env.slice(-4),
      slot,
      detail: fromEnvFile
        ? `read from ./.env (${names.env}) — the same file this dashboard has always written`
        : `read from the environment (${names.env}, set outside ./.env — the shell or the launcher)`,
    };
  }
  const file = readApiConfigFile();
  const value = typeof file[names.field] === 'string' ? (file[names.field] as string).trim() : '';
  if (value) {
    return {
      key: value,
      source: 'config/api_keys.json',
      tail: value.slice(-4),
      slot,
      detail: slot === 2
        ? 'read from config/api_keys.json (gemini_api_key_2) — saved by Settings → "The Brain"'
        : 'read from config/api_keys.json (gemini_api_key) — the file the desktop app and every actions/*.py use',
    };
  }
  return {
    key: null,
    source: null,
    tail: null,
    slot,
    detail: slot === 2
      ? `no second key: I checked the environment (GEMINI_API_KEY_2, including ./.env) and ${API_CONFIG_PATH} (gemini_api_key_2) — that is fine, it is optional`
      : `no key found: I checked the environment (GEMINI_API_KEY, including ./.env) and ${API_CONFIG_PATH} (gemini_api_key)`,
  };
}

/** The first (normal) key. */
export function resolveGeminiKey(): KeyInfo { return resolveKeySlot(1); }
/** The optional second key, the fallback. */
export function resolveGeminiKey2(): KeyInfo { return resolveKeySlot(2); }

/** The key report an API response may carry — never the key itself. */
export function publicKeyInfo(info: KeyInfo = resolveGeminiKey()): {
  present: boolean; source: KeySource; tail: string | null; detail: string; slot: KeySlot;
} {
  return { present: Boolean(info.key), source: info.source, tail: info.tail, detail: info.detail, slot: info.slot };
}

/**
 * Which key answers NOW, and why. The first key, always — unless Google has
 * stopped it today (a 429, or it rejected the key), in which case the second
 * key takes over until local midnight. When every key we have is stopped, the
 * report says so: that is Google stopping us, and the only thing that may.
 */
export interface ActiveKey {
  slot: KeySlot | null;
  info: KeyInfo;
  /** A plain sentence: which key, and why that one. */
  reason: string;
  /** True when Google has stopped every key we have for today. */
  stoppedByGoogle: boolean;
}

export function resolveActiveKey(): ActiveKey {
  const first = resolveKeySlot(1);
  const second = resolveKeySlot(2);
  if (!first.key && !second.key) {
    return { slot: null, info: first, reason: 'no key is set', stoppedByGoogle: false };
  }
  const counter = readBrainCounter();
  if (first.key && !counter.stopped[1]) {
    return { slot: 1, info: first, reason: 'the first key — the normal one', stoppedByGoogle: false };
  }
  if (second.key && !counter.stopped[2]) {
    const why = first.key && counter.stopped[1]
      ? `the second key — Google stopped the first one at ${clockTime(counter.stopped[1].at)} (${stopReasonText(counter.stopped[1])}); the first key is tried again after local midnight`
      : 'the second key — no first key is set';
    return { slot: 2, info: second, reason: why, stoppedByGoogle: false };
  }
  const info = first.key ? first : second;
  return { slot: info.slot, info, reason: 'Google has stopped every key we have for today', stoppedByGoogle: true };
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

// ── COUNT (the app counts and warns — only Google may stop a call) ──────────
/** Why Google stopped a key today. */
export interface StopRecord {
  /** ISO time it happened. */
  at: string;
  /** 'quota' = a real 429 from Google; 'key-rejected' = Google refused the key itself. */
  reason: 'quota' | 'key-rejected';
  /** The short text Google sent, for the terminal and Settings. */
  detail: string;
}

export interface QuotaSnapshot {
  day: string;
  /** Outbound questions today, both keys together. */
  used: number;
  /** The same count, per key. */
  perKey: { 1: number; 2: number };
  /** The warning level. 0 means "never warn". It never blocks. */
  warnAt: number;
  warnSource: string;
  /** True once today's count has reached the warning level. */
  pastWarn: boolean;
  /** The file exists but could not be read: counting continues in memory, nothing is blocked. */
  unreadable: boolean;
  saved: boolean;
  resets: string;
  /** Which key is answering now (1 or 2), or null when there is no key. */
  activeKey: KeySlot | null;
  activeReason: string;
  /** Per key: Google's stop for today, or null. */
  googleStopped: { 1: StopRecord | null; 2: StopRecord | null };
  /** True only when Google has stopped EVERY key we have: no calls until local midnight. */
  stoppedByGoogle: boolean;
  /** When the second key took over today, if it did. */
  switchedAt: string | null;
  /** True when a second key is set. */
  hasSecondKey: boolean;
  /** A plain sentence the terminal and Settings can print. */
  summary: string;
  source: string;
  note: string;
}

export interface WarnInfo { warnAt: number; source: string; }

/**
 * The warning level for the day's count. SUPPER_GEMINI_DAILY_WARN first; the
 * old SUPPER_GEMINI_DAILY_BUDGET is honoured as a warning level too (it used
 * to be the hard limit — it no longer blocks anything); then the default.
 */
export function resolveDailyWarn(): WarnInfo {
  const parse = (raw: string) => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const warn = (process.env.SUPPER_GEMINI_DAILY_WARN || '').trim();
  if (warn) {
    const value = parse(warn);
    if (value !== null) return { warnAt: value, source: 'SUPPER_GEMINI_DAILY_WARN' };
    return { warnAt: DEFAULT_DAILY_WARN, source: `the app's default (${DEFAULT_DAILY_WARN}) — SUPPER_GEMINI_DAILY_WARN could not be read` };
  }
  const legacy = (process.env.SUPPER_GEMINI_DAILY_BUDGET || '').trim();
  if (legacy) {
    const value = parse(legacy);
    if (value !== null && value > 0) {
      return { warnAt: value, source: 'SUPPER_GEMINI_DAILY_BUDGET (the old limit — it is only a warning level now and never blocks; SUPPER_GEMINI_DAILY_WARN replaces it)' };
    }
  }
  return { warnAt: DEFAULT_DAILY_WARN, source: `the app's default (${DEFAULT_DAILY_WARN})` };
}

// A counter file that exists but cannot be read is left alone (the owner may want
// to look at it) and the count carries on in memory for the day — it WARNS, it
// never blocks. Each counter file keeps its own state.
const unreadableDay: Record<string, string> = {};
const saveFailed: Record<string, boolean> = {};

function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stopReasonText(stop: StopRecord): string {
  return stop.reason === 'quota' ? "Google's quota, a real 429" : 'Google rejected the key itself';
}

// ── The brain's counter: total, per key, and Google's stops ─────────────────
interface BrainCounter {
  day: string;
  used: number;
  keys: { 1: number; 2: number };
  stopped: { 1: StopRecord | null; 2: StopRecord | null };
  switchedAt: string | null;
  unreadable: boolean;
}

function freshBrainCounter(day: string, unreadable = false): BrainCounter {
  return { day, used: 0, keys: { 1: 0, 2: 0 }, stopped: { 1: null, 2: null }, switchedAt: null, unreadable };
}

/** The in-memory count for a day whose file could not be read. */
let memoryBrainCounter: BrainCounter | null = null;
let unreadableWarned = '';

function readStop(value: unknown): StopRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { at?: unknown; reason?: unknown; detail?: unknown };
  if (typeof v.at !== 'string' || !v.at) return null;
  return {
    at: v.at,
    reason: v.reason === 'key-rejected' ? 'key-rejected' : 'quota',
    detail: typeof v.detail === 'string' ? v.detail : '',
  };
}

function readBrainCounter(): BrainCounter {
  const day = localDay();
  if (unreadableDay[QUOTA_FILE] === day) {
    if (!memoryBrainCounter || memoryBrainCounter.day !== day) memoryBrainCounter = freshBrainCounter(day, true);
    return memoryBrainCounter;
  }
  memoryBrainCounter = null;
  if (!fs.existsSync(QUOTA_FILE)) return freshBrainCounter(day);
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8')) as {
      day?: unknown; used?: unknown; keys?: Record<string, unknown>; google_stopped?: Record<string, unknown>; switched_at?: unknown;
    };
    const used = Number(data?.used);
    if (!Number.isFinite(used) || used < 0) throw new Error('the counter is not a number');
    if (data?.day !== day) return freshBrainCounter(day);       // yesterday's count: a new day starts at zero
    const perKey = (slot: KeySlot): number => {
      const n = Number(data.keys?.[String(slot)]);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    };
    // A file in the old {day, used} shape counts everything against the first key.
    const keys = data.keys && typeof data.keys === 'object' ? { 1: perKey(1), 2: perKey(2) } : { 1: Math.floor(used), 2: 0 };
    return {
      day,
      used: Math.floor(used),
      keys,
      stopped: { 1: readStop(data.google_stopped?.['1']), 2: readStop(data.google_stopped?.['2']) },
      switchedAt: typeof data.switched_at === 'string' ? data.switched_at : null,
      unreadable: false,
    };
  } catch (err) {
    unreadableDay[QUOTA_FILE] = day;
    memoryBrainCounter = freshBrainCounter(day, true);
    if (unreadableWarned !== day) {
      unreadableWarned = day;
      console.warn(`[config] WARNING: runtime/quota.json exists but could not be read (${err instanceof Error ? err.message : String(err)}). Nothing is blocked — the count continues in memory until local midnight. Fix or delete the file and restart JARVIS to count in it again.`);
    }
    return memoryBrainCounter;
  }
}

function writeBrainCounter(counter: BrainCounter): void {
  if (counter.unreadable) { memoryBrainCounter = counter; return; }   // never overwrite a file we could not read
  const tmp = `${QUOTA_FILE}.tmp`;
  try {
    fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
    // {day, used} first: the shape the engine room (backend/quota.py) reads.
    fs.writeFileSync(tmp, JSON.stringify({
      day: counter.day,
      used: counter.used,
      keys: { '1': counter.keys[1], '2': counter.keys[2] },
      google_stopped: { '1': counter.stopped[1], '2': counter.stopped[2] },
      switched_at: counter.switchedAt,
    }), { mode: 0o600 });
    fs.renameSync(tmp, QUOTA_FILE);
    saveFailed[QUOTA_FILE] = false;
  } catch {
    saveFailed[QUOTA_FILE] = true;          // counting continues in memory; diagnostics shows it
  }
}

/** The one-line account of today, for the terminal, Settings and the chat. */
function summarise(counter: BrainCounter, warn: WarnInfo, active: ActiveKey, hasSecondKey: boolean): string {
  const parts: string[] = [];
  parts.push(`${counter.used} Gemini call${counter.used === 1 ? '' : 's'} today (key 1: ${counter.keys[1]}, key 2: ${counter.keys[2]})`);
  if (warn.warnAt > 0 && counter.used >= warn.warnAt) parts.push(`⚠ at or past your warning level of ${warn.warnAt} — the count never blocks, this is only a warning`);
  else if (warn.warnAt > 0) parts.push(`warning level ${warn.warnAt}`);
  if (counter.unreadable) parts.push('⚠ runtime/quota.json could not be read, so this is the count since the server started');
  if (active.stoppedByGoogle) parts.push('GOOGLE HAS STOPPED US for today (not this app) — calls resume at local midnight');
  else if (active.slot === 2 && counter.stopped[1]) parts.push(`answering on the SECOND key since ${clockTime(counter.stopped[1].at)} — Google stopped the first one`);
  else if (active.slot) parts.push(`answering on key ${active.slot}`);
  if (!hasSecondKey && !active.stoppedByGoogle) parts.push('no second key set');
  return parts.join(' · ');
}

export function quotaSnapshot(): QuotaSnapshot {
  const warn = resolveDailyWarn();
  const counter = readBrainCounter();
  const active = resolveActiveKey();
  const hasSecondKey = Boolean(resolveKeySlot(2).key);
  return {
    day: counter.day,
    used: counter.used,
    perKey: { 1: counter.keys[1], 2: counter.keys[2] },
    warnAt: warn.warnAt,
    warnSource: warn.source,
    pastWarn: warn.warnAt > 0 && counter.used >= warn.warnAt,
    unreadable: counter.unreadable,
    saved: !saveFailed[QUOTA_FILE],
    resets: 'local midnight',
    activeKey: active.slot,
    activeReason: active.reason,
    googleStopped: { 1: counter.stopped[1], 2: counter.stopped[2] },
    stoppedByGoogle: active.stoppedByGoogle,
    switchedAt: counter.switchedAt,
    hasSecondKey,
    summary: summarise(counter, warn, active, hasSecondKey),
    source: warn.source,
    note: "This app's own count in runtime/quota.json, shared with the engine room. It warns and never blocks; only a real 429 from Google stops calls, and only until local midnight. Google's real limit differs by model and project; check AI Studio.",
  };
}

// ── What happened: the server prints these in the terminal and the dashboard ─
export type QuotaEvent =
  | { kind: 'warn'; used: number; warnAt: number; message: string }
  | { kind: 'unreadable'; message: string }
  | { kind: 'offline'; offline: boolean; reason: OfflineReason | null; message: string }
  | { kind: 'key-stopped'; slot: KeySlot; reason: StopRecord['reason']; switchedTo: KeySlot | null; message: string };

let quotaListener: ((event: QuotaEvent) => void) | null = null;
/** server.ts registers one listener so every event is shown in the terminal AND the dashboard. */
export function onQuotaEvent(listener: ((event: QuotaEvent) => void) | null): void {
  quotaListener = listener;
}
function emit(event: QuotaEvent): void {
  try { if (quotaListener) quotaListener(event); } catch { /* a listener must never break a call */ }
}
let warnAnnounced = '';
let unreadableAnnounced = '';

export interface SpendResult {
  /** False ONLY when the app is offline (Google stopped every key, no key, or the owner's switch). The count never says no. */
  allowed: boolean;
  slot: KeySlot | null;
  snapshot: QuotaSnapshot;
  /** A warning to show — the call still goes through. */
  warning: string | null;
  /** Why the app is offline, when it is. The caller answers locally instead of stopping. */
  offline: OfflineSnapshot;
}

/**
 * Count ONE unit for ONE QUESTION that is about to reach Gemini — the
 * standalone app's rule (one spend, one call): retries of the same question
 * (another model, another thinking setting) do NOT count again, because they
 * fetched no new answer. The one exception is the switch to the second key,
 * see countRetryOnKey(). Local answers never come here at all. This counts
 * and warns; it only refuses when the app is OFFLINE — Google has stopped
 * every key we have for today, no key is set, or the owner switched it off.
 * An offline refusal is not a block on the chat: the caller answers locally
 * and says so in one line. Nothing is counted for a call never made.
 */
export function spendGeminiCall(): SpendResult {
  const active = resolveActiveKey();
  const offline = offlineSnapshot();
  if (!active.slot || offline.offline) {
    // Offline: no call is made, so nothing is counted, and the caller answers
    // from this computer instead of stopping the conversation.
    return { allowed: false, slot: active.slot, snapshot: quotaSnapshot(), warning: null, offline };
  }
  const counter = readBrainCounter();
  counter.used += 1;
  counter.keys[active.slot] += 1;
  writeBrainCounter(counter);

  const warnings: string[] = [];
  const warn = resolveDailyWarn();
  if (warn.warnAt > 0 && counter.used >= warn.warnAt) {
    const message = `⚠ ${counter.used} Gemini call${counter.used === 1 ? '' : 's'} today — ${counter.used === warn.warnAt ? 'that reaches' : 'past'} your warning level of ${warn.warnAt} (${warn.source}). The call still goes through: this count never blocks, only Google can.`;
    console.warn(`[JARVIS] ${message}`);
    warnings.push(message);
    if (warnAnnounced !== counter.day) { warnAnnounced = counter.day; emit({ kind: 'warn', used: counter.used, warnAt: warn.warnAt, message }); }
  }
  if (counter.unreadable) {
    const message = '⚠ runtime/quota.json could not be read, so the day\'s count is being kept in memory only (nothing is blocked). Fix or delete that file and restart JARVIS to count in it again.';
    warnings.push(message);
    if (unreadableAnnounced !== counter.day) { unreadableAnnounced = counter.day; emit({ kind: 'unreadable', message }); }
  }
  return { allowed: true, slot: active.slot, snapshot: quotaSnapshot(), warning: warnings.length ? warnings.join(' ') : null, offline };
}

/**
 * The one exception to "one unit per question": when Google stops key 1 and
 * the same question goes out again on key 2, that is a real call on key 2 and
 * Google counts it against key 2 — so the per-key count does too (it happens
 * at most once a day, at the moment of the switch).
 */
export function countRetryOnKey(slot: KeySlot): void {
  const counter = readBrainCounter();
  counter.used += 1;
  counter.keys[slot] += 1;
  writeBrainCounter(counter);
}

/**
 * Google refused this key — a real 429 (its quota) or the key itself — so the
 * key is stopped until local midnight. If the OTHER key is set and not stopped,
 * it takes over now; the caller retries the same question on it.
 */
export function markKeyStoppedByGoogle(slot: KeySlot, reason: StopRecord['reason'], detail: string): { switchedTo: KeySlot | null; allStopped: boolean } {
  const counter = readBrainCounter();
  const now = new Date().toISOString();
  if (!counter.stopped[slot]) counter.stopped[slot] = { at: now, reason, detail: trimRaw(detail) };
  const other: KeySlot = slot === 1 ? 2 : 1;
  const switchedTo: KeySlot | null = resolveKeySlot(other).key && !counter.stopped[other] ? other : null;
  if (switchedTo && !counter.switchedAt) counter.switchedAt = now;
  writeBrainCounter(counter);

  const why = reason === 'quota' ? 'Google answered 429 — its own quota is used up for this key' : 'Google rejected the key itself';
  const message = switchedTo
    ? `Google stopped key ${slot} (${why}). Switching to key ${switchedTo} for the rest of the day; key ${slot} is tried again after local midnight.`
    : `Google stopped key ${slot} (${why})${resolveKeySlot(other).key ? ` — and key ${other} is stopped too` : ' — and no second key is set'}. GOOGLE HAS STOPPED US for today, not this app; calls resume at local midnight.`;
  console.warn(`[JARVIS] ${message}`);
  emit({ kind: 'key-stopped', slot, reason, switchedTo, message });
  return { switchedTo, allStopped: !switchedTo };
}

// ── OFFLINE MODE: Google running out is a mode, not a dead end ──────────────
/**
 * The owner's rule: JARVIS works offline as well as online.
 *
 * Google's quota is not this app's to control. When Google answers 429 for every
 * key we hold, the app does NOT stop and it does NOT keep apologising — it goes
 * OFFLINE and carries on with everything that runs on this computer: the chat
 * still answers (from the local knowledge base, memory, drafts, reminders, the
 * time, arithmetic, the rooms, diagnostics, the voice), and nothing is fetched
 * from the internet until the keys come back at local midnight. A 429 is
 * therefore a WARNING the owner is told about once, never a block on the chat.
 *
 * Offline has three causes, all reported honestly:
 *   'google-stopped'  every key was refused by Google today (a real 429, or the
 *                     key itself) — automatic, and over at local midnight;
 *   'no-key'          no Gemini key is configured at all;
 *   'manual'          the owner switched the app offline on purpose.
 *
 * The manual switch is remembered in runtime/offline.json (git-ignored) so a
 * deliberate "stay on this computer today" survives a restart; SUPPER_OFFLINE
 * (1/0) does the same from the environment. Setting it back to automatic lets
 * Google's own state decide again.
 */
export const OFFLINE_FILE = path.join(RUNTIME_DIR, 'offline.json');

export type OfflineReason = 'google-stopped' | 'no-key' | 'manual';

export interface OfflineSnapshot {
  /** True when no call may go to the internet and the app answers locally. */
  offline: boolean;
  reason: OfflineReason | null;
  /** One plain sentence saying why, for the terminal, Settings and the chat. */
  why: string;
  /** True while the owner's own switch is what holds the app offline. */
  forced: boolean;
  /** The owner's switch: true = stay offline, false = stay online, null = automatic. */
  override: boolean | null;
  /** ISO time the app went offline, when it is known. */
  since: string | null;
  /** What still works, because it never leaves this computer. */
  works: string[];
  /** What is refused while offline, because it would need the internet. */
  refused: string[];
  /** A short line for the chat: a warning, never a block. */
  warning: string;
  summary: string;
  note: string;
}

/** What runs on this computer and therefore keeps running offline. */
export const OFFLINE_WORKS: string[] = [
  'chat and small talk (answered from this computer)',
  'the local knowledge base — every stored and taught answer, free',
  'memory, notes, topics, tasks and reminders',
  'the drafting desk (an email or a letter, written here)',
  'time, date and arithmetic',
  'system status and diagnostics',
  'the rooms, the file browser, the camera and My Hands',
  'the local voice (the browser voice, or Kokoro/faster-whisper on this machine)',
];

/** What needs the internet, and is therefore refused while offline. */
export const OFFLINE_REFUSED: string[] = [
  'a fresh open-ended answer from Gemini',
  'Internet Research and any web search',
  'AI pictures and video scripts',
  'the server TTS voice (the local voice still speaks)',
];

function readOfflineOverride(): { override: boolean | null; at: string | null } {
  const env = (process.env.SUPPER_OFFLINE || '').trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes' || env === 'on') return { override: true, at: null };
  if (env === '0' || env === 'false' || env === 'no' || env === 'off') return { override: false, at: null };
  try {
    if (!fs.existsSync(OFFLINE_FILE)) return { override: null, at: null };
    const data = JSON.parse(fs.readFileSync(OFFLINE_FILE, 'utf-8')) as { forced?: unknown; at?: unknown };
    if (typeof data?.forced !== 'boolean') return { override: null, at: null };
    return { override: data.forced, at: typeof data.at === 'string' ? data.at : null };
  } catch {
    return { override: null, at: null };        // an unreadable switch means "automatic", never "broken"
  }
}

/** The owner's own switch, with the honest sentence that goes with the result. */
export type OfflineSwitchResult = OfflineSnapshot & { message: string };

/** Switch the app offline (or back online) by hand. `null` returns to automatic. */
export function setOfflineMode(on: boolean | null): OfflineSwitchResult {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    if (on === null) {
      if (fs.existsSync(OFFLINE_FILE)) fs.rmSync(OFFLINE_FILE);
    } else {
      writeFileAtomic(OFFLINE_FILE, JSON.stringify({ forced: on, at: new Date().toISOString() }));
    }
  } catch (err) {
    console.warn('[config] the offline switch could not be saved:', err instanceof Error ? err.message : err);
  }
  const snapshot = offlineSnapshot();
  // The switch is only ever the owner's half of the decision: it can force
  // offline, but it cannot conjure a key or lift Google's 429. So the words
  // follow the state that was actually measured, never a promise.
  const said = on === true
    ? 'OFFLINE by your own switch — local only, nothing will be fetched from the internet until you switch it back.'
    : on === false && snapshot.offline
      ? `The switch is back to automatic, but I am still offline — ${snapshot.why}${snapshot.reason === 'google-stopped' ? ' until local midnight' : ''}. The keys are used again the moment that lifts.`
      : on === false
        ? 'Online again: the keys will be used as soon as Google accepts them.'
        : 'The offline switch is back to automatic: Google\'s own state decides.';
  console.warn(`[JARVIS] ${said}`);
  emit({ kind: 'offline', offline: snapshot.offline, reason: snapshot.reason, message: `${said} ${snapshot.summary}` });
  return { ...snapshot, message: said };
}

/** The app's connectivity state right now, and what it means for each feature. */
export function offlineSnapshot(): OfflineSnapshot {
  const { override, at } = readOfflineOverride();
  const quota = quotaSnapshot();
  const hasKey = Boolean(resolveKeySlot(1).key) || Boolean(resolveKeySlot(2).key);
  let reason: OfflineReason | null = null;
  let why = '';
  let since: string | null = at;
  if (override === true) {
    reason = 'manual';
    why = 'you switched the app offline yourself';
  } else if (quota.stoppedByGoogle) {
    reason = 'google-stopped';
    const stops = [quota.googleStopped[1], quota.googleStopped[2]].filter(Boolean) as StopRecord[];
    since = stops.map((s) => s.at).sort().pop() || null;
    const which = [1, 2].filter((slot) => quota.googleStopped[slot as KeySlot]);
    why = `Google answered 429 for ${which.length === 2 ? 'both keys' : `key ${which[0]}`} — its own quota, not this app's count`;
  } else if (!hasKey) {
    reason = 'no-key';
    why = 'no Gemini key is set on this computer';
    since = null;                                  // not a moment — a key that is missing
  }
  const offline = reason !== null;
  const summary = offline
    ? `OFFLINE — local only (${why}). The chat keeps working; nothing is fetched from the internet${reason === 'google-stopped' ? ' until local midnight' : ''}.`
    : 'Online — the keys are usable, and local answers are still tried first so most work never spends a call.';
  return {
    offline,
    reason,
    why,
    forced: override === true,
    override,
    since,
    works: OFFLINE_WORKS,
    refused: OFFLINE_REFUSED,
    warning: offline
      ? `I am offline (${why}), so I answered from this computer and fetched nothing from the internet.`
      : '',
    summary,
    note: "Offline is a mode, not an error: the app counts and warns, Google's 429 only decides whether the internet may be used, and every local feature keeps working either way.",
  };
}

/** True when no call may leave this computer. */
export function isOffline(): boolean {
  return offlineSnapshot().offline;
}

/**
 * The honest refusal for a feature that would need the internet. It says what
 * happened, that the chat itself is still working, and when the internet comes
 * back — because "you cannot do that" with no reason and no way out is exactly
 * what makes an assistant feel broken.
 */
export function offlineRefusal(feature: string): string {
  const state = offlineSnapshot();
  if (!state.offline) return '';
  const back = state.reason === 'google-stopped'
    ? ' The keys come back at local midnight, or sooner if you add a key from another Google account in Settings → "The Brain".'
    : state.reason === 'no-key'
      ? ' Add a key in Settings → "The Brain" and it works at once.'
      : ' Say "come back online" (or switch it in Settings) and it works again.';
  return `${feature} needs the internet, and I am offline — ${state.why}. Nothing was fetched and nothing was counted.${back} ` +
    `Everything on this computer still works: ${state.works.slice(0, 4).join(', ')}.`;
}

// ── The voice's own counter (the voice is local now: it never touches Gemini) ─
interface Counter { day: string; used: number; unreadable: boolean; }

function readCounter(file: string): Counter {
  const day = localDay();
  if (unreadableDay[file] === day) return { day, used: 0, unreadable: true };
  if (!fs.existsSync(file)) return { day, used: 0, unreadable: false };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { day?: unknown; used?: unknown };
    const used = Number(data?.used);
    if (!Number.isFinite(used) || used < 0) throw new Error('the counter is not a number');
    return { day, used: data?.day === day ? Math.floor(used) : 0, unreadable: false };
  } catch {
    unreadableDay[file] = day;
    return { day, used: 0, unreadable: true };
  }
}

function writeCounter(day: string, used: number, file: string): void {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ day, used }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    saveFailed[file] = false;
  } catch {
    saveFailed[file] = true;
  }
}

export interface BudgetInfo { limit: number; source: string; }

export interface VoiceQuotaSnapshot {
  day: string; used: number; limit: number; remaining: number; enabled: boolean;
  unreadable: boolean; saved: boolean; resets: string; source: string; note: string;
}

export function resolveVoiceBudget(): BudgetInfo {
  const raw = (process.env.SUPPER_GEMINI_VOICE_BUDGET || '').trim();
  if (!raw) return { limit: DEFAULT_VOICE_BUDGET, source: `the app's default (${DEFAULT_VOICE_BUDGET} spoken sentences a day)` };
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    return { limit: DEFAULT_VOICE_BUDGET, source: `the app's default (${DEFAULT_VOICE_BUDGET}) — SUPPER_GEMINI_VOICE_BUDGET could not be read` };
  }
  return { limit: value, source: 'SUPPER_GEMINI_VOICE_BUDGET' };
}

export function voiceQuotaSnapshot(): VoiceQuotaSnapshot {
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
    note: "The voice's own count in runtime/voice_quota.json. The voice runs on this computer (Kokoro / faster-whisper) and never uses a Gemini call, so this stays at zero unless a server voice is used.",
  };
}

/** One unit for one spoken sentence generated by a SERVER voice (the local voice never calls this). */
export function trySpendVoiceBudget(): { allowed: boolean; snapshot: VoiceQuotaSnapshot } {
  const budget = resolveVoiceBudget();
  const counter = readCounter(VOICE_QUOTA_FILE);
  if (counter.unreadable || budget.limit === 0 || counter.used >= budget.limit) {
    return { allowed: false, snapshot: voiceQuotaSnapshot() };
  }
  writeCounter(counter.day, counter.used + 1, VOICE_QUOTA_FILE);
  return { allowed: true, snapshot: voiceQuotaSnapshot() };
}

/** A refused SPOKEN sentence may only close the voice's own counter — never the brain's. */
export function markVoiceBudgetExhausted(): void {
  const budget = resolveVoiceBudget();
  if (budget.limit <= 0) return;
  const counter = readCounter(VOICE_QUOTA_FILE);
  if (counter.unreadable) return;
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
  | 'no-key' | 'google-stopped' | 'offline' | 'model-unavailable' | 'key-rejected'
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

/** What Google did to each key today, in one plain sentence. */
function googleStopStory(): string {
  const snap = quotaSnapshot();
  const line = (slot: KeySlot): string => {
    const stop = snap.googleStopped[slot];
    if (stop) return `key ${slot} was stopped at ${clockTime(stop.at)} (${stopReasonText(stop)})`;
    return '';
  };
  const parts = [line(1), line(2)].filter(Boolean);
  const second = snap.hasSecondKey
    ? ''
    : ' No second key is set — add one in Settings → "The Brain" (from a different Google account/project) and I carry on with it when the first runs out.';
  return `${parts.length ? parts.join('; ') + '.' : ''}${second} This app counted ${snap.used} call${snap.used === 1 ? '' : 's'} today and did not block any of them.`;
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
    case 'google-stopped':
      return `Google has stopped our calls for today, sir — Google, not this app. ${googleStopStory()}` +
        ` So I have gone OFFLINE and I am carrying on with everything on this computer: the chat keeps working and nothing is fetched from the internet.` +
        ` That is a warning, not a block — calls resume at local midnight (Google's own daily quota resets at midnight Pacific), or sooner if you add a key from another Google account in Settings → "The Brain".`;
    case 'offline':
      return `I am OFFLINE because you switched me offline, sir, so nothing is fetched from the internet and no call is counted.` +
        ` The chat and every local feature keep working. Say "come back online" (or use the switch in Settings) and the keys are used again at once.`;
    case 'model-unavailable': {
      const tried = ctx.attempts.filter((a) => a.error).map((a) => a.model).join(', ') || ctx.model;
      return `The model name was withdrawn, sir — my key is fine, so do not change it. Google answered 404 NOT_FOUND for ${tried}.` +
        ` Set SUPPER_TEXT_MODEL (or GEMINI_MODEL) to a current model, or clear both and I fall back to the app's moving alias ${DEFAULT_TEXT_MODEL}.` +
        (ctx.raw ? ` Google said: ${trimRaw(ctx.raw)}` : '');
    }
    case 'key-rejected':
      return `Google refused key ${key.slot} itself (${key.source || 'no source'}; ending in …${key.tail ?? '????'}), which comes from ${key.detail} — the key is the problem here, not the model (${ctx.model}).` +
        ` Paste a working key in Settings → "The Brain".` + (ctx.raw ? ` Google said: ${trimRaw(ctx.raw)}` : '');
    case 'rate-limited':
      return `Google answered 429 — its own quota is used up for key ${key.slot} (ending in …${key.tail ?? '????'}) on ${ctx.model}. That is Google stopping us, sir, not this app: this app's count only warns. ${googleStopStory()}` +
        ` I am OFFLINE now and carrying on locally — the chat keeps working and nothing is fetched from the internet. ` +
        `Calls resume at local midnight (Google's own daily quota resets at midnight Pacific). Neither the key nor the model name is at fault.` +
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
 * The failure for a closed gate: the app is OFFLINE, so no call was made and
 * nothing was counted. The code says which kind of offline it is, so a caller
 * can answer locally and say so in one honest line instead of stopping.
 */
function offlineGateError(gate: SpendResult, key: KeyInfo, attempts: AttemptReport[], model: string, modelSource: string): BrainError {
  const code: BrainFailureCode = gate.offline?.reason === 'no-key' ? 'no-key'
    : gate.offline?.reason === 'manual' ? 'offline' : 'google-stopped';
  return new BrainError(
    explainBrainFailure({ code, model, modelSource, key, attempts }),
    code, attempts, model, modelSource,
  );
}

/**
 * Run one Gemini task through the configured model, then the remembered one,
 * and only then — as a last resort — whatever the key's own model list offers.
 * One question counts one unit, whatever it takes to answer it.
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
  /** Tests inject their own queue and their own counter; production uses the defaults. */
  candidates?: ModelCandidate[];
  spend?: () => SpendResult;
  /** Set false in tests that must not touch the network for discovery. */
  allowDiscovery?: boolean;
  /** Set false to send only the caller's own settings — never the speed defaults. */
  speed?: boolean;
}

export async function runBrain<T>(caller: BrainCaller | null, opts: BrainRunOptions<T>): Promise<BrainRun<T>> {
  const active = resolveActiveKey();
  let key = active.info;
  if (!caller || !key.key) {
    throw new BrainError(explainBrainFailure({ code: 'no-key', model: '', modelSource: '', key, attempts: [] }), 'no-key', [], '', '');
  }

  let candidates: ModelCandidate[] = (opts.candidates || modelCandidates(opts.kind)).slice();
  const attempted = new Set<string>();
  const attempts: AttemptReport[] = [];
  // ONE unit per QUESTION — the standalone app's rule (backend/agent.py:
  // _gemini() spends once, then makes its call). This used to spend once per
  // candidate model, so a single question whose first model was unavailable
  // burned three, five, sometimes twenty units on retries that never fetched
  // an answer. Retries of the same question are free; a new question counts
  // again. The count never refuses: the gate below is closed only when the app
  // is OFFLINE — Google has stopped every key we have, no key is set, or the
  // owner switched it off. A closed gate is never a dead end: the caller
  // answers from this computer instead.
  const spend = opts.spend || spendGeminiCall;
  const gate = spend();
  if (!gate.allowed) {
    throw offlineGateError(gate, key, attempts, candidates[0]?.model || '', candidates[0]?.source || '');
  }
  let slot: KeySlot = gate.slot ?? active.slot ?? 1;
  let switchedKey = false;
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
          const fresh = found.filter((c) => !attempted.has(c.model)).slice(0, 2);
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

      if (classified.code === 'rate-limited' || classified.code === 'key-rejected') {
        // Google refused THIS key: a real 429 (its quota) or the key itself. The
        // key is stopped until local midnight. If the other key is set, it takes
        // over now and the same question is retried on it — for free, it is a
        // retry — so the owner gets an answer instead of an apology.
        const stop = markKeyStoppedByGoogle(slot, classified.code === 'rate-limited' ? 'quota' : 'key-rejected', classified.raw);
        if (stop.switchedTo && !switchedKey) {
          switchedKey = true;
          slot = stop.switchedTo;
          key = resolveKeySlot(slot);
          attempted.clear();
          countRetryOnKey(slot);
          console.warn(`[config] retrying the same question on key ${slot} (ending in …${key.tail}) — counted as one call on key ${slot}.`);
          continue;
        }
        throw new BrainError(explainBrainFailure({ code: classified.code, model: next.model, modelSource: next.source, key, raw: classified.raw, attempts }), classified.code, attempts, next.model, next.source);
      }
      if (classified.code === 'connection') {
        // Another model cannot mend a dead connection.
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
  spend?: () => SpendResult;
  allowDiscovery?: boolean;
  speed?: boolean;
}

export async function runBrainStream(caller: BrainCaller | null, opts: BrainStreamOptions): Promise<BrainStreamRun> {
  const active = resolveActiveKey();
  let key = active.info;
  if (!caller || !key.key) {
    throw new BrainError(explainBrainFailure({ code: 'no-key', model: '', modelSource: '', key, attempts: [] }), 'no-key', [], '', '');
  }

  const allowDiscovery = opts.allowDiscovery !== false;
  const extractText = (raw: GeminiRaw): string | null =>
    (typeof raw.text === 'string' && raw.text.trim() ? raw.text.trim() : null);

  let candidates: ModelCandidate[] = (opts.candidates || modelCandidates(opts.kind)).slice();
  const attempted = new Set<string>();
  const attempts: AttemptReport[] = [];
  const spend = opts.spend || spendGeminiCall;
  // ONE unit per QUESTION, as in runBrain() and the standalone app. The count
  // never refuses; only being OFFLINE closes this gate (Google stopped every
  // key, no key is set, or the owner switched the app offline).
  const gate = spend();
  if (!gate.allowed) {
    throw offlineGateError(gate, key, attempts, candidates[0]?.model || '', candidates[0]?.source || '');
  }
  let slot: KeySlot = gate.slot ?? active.slot ?? 1;
  let switchedKey = false;
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
          const fresh = found.filter((c) => !attempted.has(c.model)).slice(0, 2);
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
    if (failure.code === 'rate-limited' || failure.code === 'key-rejected') {
      // Same rule as runBrain(): Google refused this key, so it is stopped for
      // the day; the other key, if set, takes over and this question is retried
      // on it for free.
      const stop = markKeyStoppedByGoogle(slot, failure.code === 'rate-limited' ? 'quota' : 'key-rejected', failure.raw);
      if (stop.switchedTo && !switchedKey) {
        switchedKey = true;
        slot = stop.switchedTo;
        key = resolveKeySlot(slot);
        attempted.clear();
        countRetryOnKey(slot);
        console.warn(`[config] retrying the same question on key ${slot} (ending in …${key.tail}) — counted as one call on key ${slot}.`);
        continue;
      }
      throw new BrainError(explainBrainFailure({ code: failure.code, model: next.model, modelSource: next.source, key, raw: failure.raw, attempts }), failure.code, attempts, next.model, next.source);
    }
    if (failure.code === 'connection') {
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
  /** Which key answered: 1 the normal one, 2 the fallback. */
  keySlot: KeySlot | null;
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
  const started = Date.now();
  const key = resolveActiveKey().info;
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
    // The key that answered may be the second one (a switch can happen inside
    // the call), so it is read again after the call.
    const answered = resolveActiveKey();
    return {
      ok: true, reply: run.value, model: run.model, modelSource: run.modelSource, modelVersion: run.modelVersion,
      keySource: answered.info.source, keyTail: answered.info.tail, keyDetail: answered.info.detail, keySlot: answered.slot,
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
      keySource: key.source, keyTail: key.tail, keyDetail: key.detail, keySlot: key.key ? key.slot : null,
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
export interface SaveKeyResult { savedTo: string[]; source: KeySource; detail: string; slot: KeySlot; }

/** config/api_keys.json, parsed — or an error naming the file when it exists but is not JSON. */
function readApiConfigForWriting(): Record<string, unknown> {
  const existing = fs.existsSync(API_CONFIG_PATH) ? fs.readFileSync(API_CONFIG_PATH, 'utf-8') : '';
  if (!existing.trim()) return {};
  const parsed = readJsonSafe(API_CONFIG_PATH);
  if (!parsed) throw new Error(`${API_CONFIG_PATH} exists but is not valid JSON — I will not overwrite it. Fix or move that file, then save again.`);
  return parsed;
}

/** Rewrite one NAME=value line in ./.env, if that line exists. True when it did. */
function rewriteEnvLine(name: string, value: string | null): boolean {
  if (!fs.existsSync(ENV_FILE)) return false;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const lines = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/);
  if (!lines.some((line) => pattern.test(line))) return false;
  const out = lines.flatMap((line) => (pattern.test(line) ? (value === null ? [] : [`${name}=${value}`]) : [line]));
  writeFileAtomic(ENV_FILE, out.join('\n'));
  return true;
}

/**
 * Save a key where the app reads it. Slot 1 is the normal key (gemini_api_key),
 * slot 2 the fallback (gemini_api_key_2). Both follow the same rules.
 */
export function saveGeminiKey(key: string, slot: KeySlot = 1): SaveKeyResult {
  const cleaned = key.trim();
  if (cleaned.length < 10) throw new Error('That does not look like a Gemini API key — it needs at least 10 characters.');
  const names = slotNames(slot);
  const fromShell = slot === 2 ? KEY2_FROM_SHELL : KEY_FROM_SHELL;

  // 1. The app's own settings file. Other settings in it are preserved; a file
  //    that exists but cannot be parsed is never overwritten (the owner may
  //    have hand-edited it).
  const savedTo: string[] = [];
  const file = readApiConfigForWriting();
  file[names.field] = cleaned;
  writeFileAtomic(API_CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
  savedTo.push('config/api_keys.json');

  // 2. If ./.env holds a line for this key it shadows the file (the
  //    environment is read first), so it is brought along — the key the owner
  //    just typed is then the key in force.
  if (envFileKey(slot) && rewriteEnvLine(names.env, cleaned)) {
    savedTo.push('.env');
    if (!fromShell) process.env[names.env] = cleaned;   // live at once
  }

  const info = resolveKeySlot(slot);
  const shellNote = fromShell
    ? ` The environment already carried ${names.env} before ./.env was read (the shell or the launcher), and the environment is read first — clear that variable for the saved key to take over.`
    : '';
  return {
    savedTo,
    slot,
    source: info.source,
    detail: `written to ${savedTo.join(' and ')}; in force now: ${info.detail}.${shellNote}`,
  };
}

/**
 * Remove the optional second key from config/api_keys.json (and its line in
 * ./.env, if there is one). A GEMINI_API_KEY_2 set in the shell cannot be
 * removed from here; the report says so.
 */
export function clearGeminiKey2(): { removedFrom: string[]; stillPresent: boolean; detail: string } {
  const removedFrom: string[] = [];
  const file = readApiConfigForWriting();
  if ('gemini_api_key_2' in file) {
    delete file['gemini_api_key_2'];
    writeFileAtomic(API_CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
    removedFrom.push('config/api_keys.json');
  }
  if (rewriteEnvLine('GEMINI_API_KEY_2', null)) {
    removedFrom.push('.env');
    if (!KEY2_FROM_SHELL) delete process.env.GEMINI_API_KEY_2;
  }
  const info = resolveKeySlot(2);
  return {
    removedFrom,
    stillPresent: Boolean(info.key),
    detail: info.key
      ? `removed from ${removedFrom.join(' and ') || 'nowhere'} — but a second key is still in force: ${info.detail}. Clear GEMINI_API_KEY_2 from the environment and restart to drop it.`
      : `removed from ${removedFrom.join(' and ') || 'nowhere (there was none saved)'}; no second key is set now.`,
  };
}

// ── The status the Settings pane and the diagnostics print ──────────────────
export interface ConfigStatus {
  /** The first key (the normal one). */
  key: ReturnType<typeof publicKeyInfo>;
  /** The optional second key (the fallback). */
  key2: ReturnType<typeof publicKeyInfo>;
  /** Which key answers now, and why. */
  activeKey: { slot: KeySlot | null; tail: string | null; source: KeySource; reason: string; stoppedByGoogle: boolean };
  model: { text: string; textSource: string; image: string; imageSource: string };
  names: NameInfo;
  quota: QuotaSnapshot;
}

export function configStatus(): ConfigStatus {
  const key = resolveGeminiKey();
  const key2 = resolveGeminiKey2();
  const active = resolveActiveKey();
  const text = resolveTextModel();
  const image = resolveImageModel();
  return {
    key: publicKeyInfo(key),
    key2: publicKeyInfo(key2),
    activeKey: { slot: active.slot, tail: active.info.tail, source: active.info.source, reason: active.reason, stoppedByGoogle: active.stoppedByGoogle },
    model: { text: text.model, textSource: text.source, image: image.model, imageSource: image.source },
    names: resolveNames(),
    quota: quotaSnapshot(),
  };
}
