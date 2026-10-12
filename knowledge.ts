/**
 * The local knowledge base — the SAME store the previous JARVIS (the Python
 * engine room, backend/knowledge.py) reads and writes.
 *
 * The owner's rule: the AI is used as little as possible. A question that has
 * been answered before, or that the assistant was taught, is answered from this
 * file with no Gemini call and no budget unit. Only a question nothing here can
 * answer goes to the model — and then the answer is kept, so the same question
 * is never paid for twice.
 *
 * Both halves of the project share ONE file, in the engine room's own format:
 *
 *   runtime/knowledge.json   { "version": 2, "entries": [...], "archive": [...], "next_id": N }
 *     entry: { id, kind, key, question, keywords, answer, created, last_used,
 *              uses, expires }
 *     kind:  "starter"  written by the assistant, from knowledge/starter.json
 *            "owner"    taught by the owner with "learn: <question> = <answer>"
 *            "gemini"   an answer Gemini gave earlier, kept and shown with its date,
 *                        and now with `provenance` ({ schema, source, model, recorded })
 *                        recording WHICH MODEL produced it.
 *
 * Version 2 added `provenance` to new Gemini answers. Both halves of the project still
 * read version 1 (and a file with no version at all): an entry with no provenance is
 * simply STALE, not trusted — it can never silently stand in for an answer from the
 * model in use now. A stale entry is only used when the model cannot be reached at all,
 * and then it is described as out of date (`describeStale`). When a fresh answer takes
 * its place the old entry moves to the archive (`superseded by ...`); nothing is deleted.
 *
 * The matching rules, the wording of the replies and the file shape are the
 * engine room's, deliberately: an entry taught in the desktop app answers a
 * question typed into the dashboard, and the other way round.
 *
 * Nothing is ever deleted: forgotten and expired entries move to "archive", and
 * a damaged file is kept aside as knowledge.json.bad-<time> and the store starts
 * again. The owner's memory (memory/long_term.json) is a different file and is
 * never touched here.
 *
 * Provenance: written for this project, mirroring backend/knowledge.py (the
 * owner's own module, written 2026-10-10). No code taken from other projects.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR, REPO_ROOT } from './config.js';

export const KNOWLEDGE_FILE = path.join(RUNTIME_DIR, 'knowledge.json');
export const STARTER_FILE = path.join(REPO_ROOT, 'knowledge', 'starter.json');
export const DEFAULT_KNOWLEDGE_DAYS = 30;
/** The file's schema version — 2 adds `provenance` to new Gemini answers (see above). */
export const KNOWLEDGE_VERSION = 2;
export const PROVENANCE_SCHEMA = 2;
const MAX_QUESTION_CHARS = 200;
const MAX_ANSWER_CHARS = 2000;
const MIN_OVERLAP = 0.75;

// backend/recall.py's stop words, then backend/knowledge.py's filler words.
const STOP = new Set(['what', 'whats', "what's", 'is', 'was', 'are', 'were', 'my', 'me', 'the', 'a', 'an', 'do', 'you',
  'know', 'remember', 'about', 'of', 'for', 'your', 'i', 'tell', 'did', 'say', 'anything', 'it',
  'that', 'to', 'in', 'on', 'and', 'or', 'this', 'please', 'has', 'have']);
const FILLER = new Set(['how', 'can', 'could', 'should', 'would', 'i', 'we', 'you', 'does', 'with', 'from',
  'into', 'need', 'want', 'way', 'there', 'where', 'when', 'which', 'who', 'best',
  'but', 'please', 'tell', 'explain', 'define', 'mean', 'meaning', 'just', 'also',
  'really', 'convert', 'give', 'show']);

/** "colours" matches "colour"; plain plurals only. Short words are left alone. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

/** The meaningful words of a question — the same rules as backend/knowledge.py. */
export function keywords(text: string): string[] {
  return words(text).filter((w) => w.length > 1 && !STOP.has(w) && !FILLER.has(w)).map(stem);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  a.forEach((w) => { if (b.has(w)) shared++; });
  return shared / (a.size + b.size - shared);
}

// Anything that changes over time, or depends on today: never kept.
const TIME_SENSITIVE = /\b(today|tonight|tomorrow|yesterday|now|right now|currently|current|latest|recent|newest|news|price|prices|weather|forecast|score|scores|stock|stocks|exchange rate|this week|this month|this year|next week|breaking|who won|as of|live)\b|\b20[2-9]\d\b/i;
// Questions about the owner: their answers belong to the owner, not to the store.
const PERSONAL = /\b(my|mine|me|our|ours)\b/i;
// Answers that admit they may be out of date, or that Gemini could not look anything up.
const UNSURE_ANSWER = /as of my|real[- ]time|up[- ]to[- ]date|knowledge cutoff|i (?:can't|cannot|don't have access)/i;

const STARTER_NOTE = ' [starter answer written by the assistant: please check]';

export interface KnowledgeProvenance {
  schema: number;
  source: string;
  /** The model that produced the answer; '' when it was not recorded. */
  model: string;
  recorded: string;
}

export interface KnowledgeEntry {
  id: number;
  kind: 'starter' | 'owner' | 'gemini';
  key: string;
  question: string;
  keywords: string[];
  answer: string;
  created: string;
  last_used: string;
  uses: number;
  expires: string;
  provenance?: KnowledgeProvenance;
  archived_at?: string;
  archive_reason?: string;
}

interface KnowledgeFile { version?: number; entries: KnowledgeEntry[]; archive: KnowledgeEntry[]; next_id: number; }

function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** May a Gemini answer be kept? The engine room's rules, word for word. */
export function mayKeepAnswer(question: string, answer: string): boolean {
  if (String(question).length > MAX_QUESTION_CHARS || String(answer).length > MAX_ANSWER_CHARS) return false;
  if (TIME_SENSITIVE.test(question) || PERSONAL.test(question)) return false;
  if (UNSURE_ANSWER.test(answer)) return false;
  return keywords(question).length > 0;
}

export function learningEnabled(): boolean {
  return String(process.env.SUPPER_KNOWLEDGE_LEARN || '').trim().toLowerCase() !== 'off';
}

function knowledgeDays(): number {
  const raw = Number.parseInt(String(process.env.SUPPER_KNOWLEDGE_DAYS || '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KNOWLEDGE_DAYS;
}

export class KnowledgeStore {
  path: string;
  starterPath: string;
  private entries: KnowledgeEntry[] = [];
  private archive: KnowledgeEntry[] = [];
  private nextId = 1;
  private loaded = false;
  private lastStamp = '';
  private starterKeys = new Set<string>();
  lastProblem = '';

  constructor(file: string = KNOWLEDGE_FILE, starterPath: string = STARTER_FILE) {
    this.path = file;
    this.starterPath = starterPath;
  }

  /** The store the whole dashboard shares. */
  static shared: KnowledgeStore | null = null;
  static get(): KnowledgeStore {
    if (!KnowledgeStore.shared) KnowledgeStore.shared = new KnowledgeStore();
    return KnowledgeStore.shared;
  }

  /** The best stored entry for this question, or null. Counts a use when found. */
  lookup(question: string): KnowledgeEntry | null {
    const wanted = new Set(keywords(question));
    if (!wanted.size) return null;
    this.ensureLoaded();
    this.reloadIfChanged();
    this.expire();
    let best: KnowledgeEntry | null = null;
    let bestScore = 0;
    for (const entry of this.entries) {
      const stored = new Set(entry.keywords || []);
      const score = jaccard(wanted, stored);
      if (score < MIN_OVERLAP) continue;
      if (wanted.size + stored.size < 2 && wanted.size !== stored.size) continue;
      if (!best || score > bestScore) { best = entry; bestScore = score; }
    }
    if (!best) return null;
    best.uses = Number(best.uses || 0) + 1;
    best.last_used = nowIso();
    this.save();
    return { ...best };
  }

  listEntries(): KnowledgeEntry[] {
    this.ensureLoaded();
    this.reloadIfChanged();
    this.expire();
    return this.entries.map((e) => ({ ...e }));
  }

  count(): number { return this.listEntries().length; }

  /** The reply text for a stored entry that may be answered directly — the engine room's wording. */
  describe(entry: KnowledgeEntry): string {
    if (entry.kind === 'starter') return entry.answer + STARTER_NOTE;
    if (entry.kind === 'gemini') return `${entry.answer} (saved from an earlier Gemini answer, ${String(entry.created).slice(0, 10)})`;
    return entry.answer;
  }

  /** The recorded model information for an entry; an empty object when there is none. */
  provenanceOf(entry: KnowledgeEntry): Partial<KnowledgeProvenance> {
    const provenance = entry && typeof entry === 'object' ? (entry as KnowledgeEntry).provenance : undefined;
    return provenance && typeof provenance === 'object' ? provenance : {};
  }

  /**
   * True when a stored GEMINI answer must not answer in place of the current model.
   *
   * Starter and taught answers are the owner's (or the assistant's) own words — no model
   * made them, so they are never stale. A Gemini answer is stale when it does not record
   * which model produced it (every entry written before provenance existed) or when it
   * records a different model from the one this app uses now.
   */
  isStale(entry: KnowledgeEntry, currentModel: string): boolean {
    if (!entry || entry.kind !== 'gemini') return false;
    const madeBy = String(this.provenanceOf(entry).model || '').trim();
    if (!madeBy) return true;                       // no record of its model: never trusted silently
    const now = String(currentModel || '').trim();
    if (!now) return false;                         // nothing to compare with; cannot call it out of date
    return madeBy !== now;
  }

  /**
   * The reply for a stored Gemini answer used only because the model could not be reached.
   * It says exactly what it is: an earlier answer, from a recorded (or unrecorded) model,
   * not re-checked just now, so possibly out of date.
   */
  describeStale(entry: KnowledgeEntry, currentModel = ''): string {
    const madeBy = String(this.provenanceOf(entry).model || '').trim() || 'a model this app no longer records';
    const madeOn = String(entry.created || '').slice(0, 10);
    const now = String(currentModel || '').trim();
    const rechecked = now ? `not re-checked with ${now}` : 'not re-checked';
    return `${entry.answer} (saved from an earlier Gemini answer on ${madeOn}, made by ${madeBy}; `
      + `${rechecked} — the AI could not be reached just now, so please check anything that may have changed since)`;
  }

  /**
   * Keep a Gemini answer so the same question is never paid for twice.
   *
   * `model` is the model that produced the answer and is recorded with the entry.
   * Nothing is overwritten blindly: an entry the owner taught, or a starter answer, is
   * never replaced; the same model's existing answer is not paid for twice; and a STALE
   * Gemini entry moves to the archive (with the reason) as the fresh answer takes its place.
   */
  learn(question: string, answer: string, model = ''): KnowledgeEntry | null {
    if (!learningEnabled()) return null;
    const q = String(question || '').trim();
    const a = String(answer || '').trim();
    if (!q || !a || !mayKeepAnswer(q, a)) return null;
    this.ensureLoaded();
    const existing = this.findExact(q);
    if (existing) {
      if (existing.kind !== 'gemini') return null;          // the owner's or the assistant's answer wins
      if (!String(model || '').trim() || !this.isStale(existing, model)) return null;
      this.moveToArchive(existing, `superseded by ${model}`);
    }
    const expires = new Date(Date.now() + knowledgeDays() * 86400000);
    return this.add('gemini', q, a, expires.toISOString().slice(0, 19), '', model);
  }

  /** Move one entry to the archive. Nothing is ever deleted. */
  private moveToArchive(entry: KnowledgeEntry, reason: string): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
    entry.archived_at = nowIso();
    entry.archive_reason = reason;
    this.archive.push(entry);
  }

  /** Teach an answer by hand: "learn: <question> = <answer>". */
  teach(question: string, answer: string): KnowledgeEntry {
    const q = String(question || '').trim();
    const a = String(answer || '').trim();
    if (!q || !a) throw new Error('a question and an answer are both needed');
    if (q.length > MAX_QUESTION_CHARS || a.length > MAX_ANSWER_CHARS) throw new Error('that is too long to keep as one answer');
    if (!keywords(q).length) throw new Error('the question has no meaningful words to match on');
    this.ensureLoaded();
    return this.add('owner', q, a, '');
  }

  /** Move an entry to the archive. Nothing is deleted. */
  forget(id: number): KnowledgeEntry | null {
    this.ensureLoaded();
    const i = this.entries.findIndex((e) => Number(e.id) === Number(id));
    if (i < 0) return null;
    const [moved] = this.entries.splice(i, 1);
    moved.archived_at = nowIso();
    moved.archive_reason = 'forgotten by owner';
    this.archive.push(moved);
    this.save();
    return { ...moved };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private add(kind: KnowledgeEntry['kind'], question: string, answer: string, expires: string, key = '',
              model = ''): KnowledgeEntry {
    const entry: KnowledgeEntry = {
      id: this.nextId, kind, key,
      question, keywords: keywords(question), answer,
      created: nowIso(), last_used: '', uses: 0, expires,
    };
    if (kind === 'gemini') {
      // Which model produced this answer. An empty name is recorded honestly: the entry
      // is then treated as stale next time rather than trusted silently.
      entry.provenance = { schema: PROVENANCE_SCHEMA, source: 'gemini', model: String(model || '').trim(), recorded: nowIso() };
    }
    this.nextId += 1;
    this.entries.push(entry);
    this.save();
    return { ...entry };
  }

  private findExact(question: string): KnowledgeEntry | undefined {
    const wanted = new Set(keywords(question));
    return this.entries.find((e) => {
      const stored = new Set(e.keywords || []);
      return stored.size === wanted.size && [...wanted].every((w) => stored.has(w));
    });
  }

  private expire(): void {
    const now = Date.now();
    const kept: KnowledgeEntry[] = [];
    let moved = false;
    for (const entry of this.entries) {
      const expires = entry.expires || '';
      const when = expires ? Date.parse(expires) : NaN;
      if (expires && Number.isFinite(when) && when <= now) {
        entry.archived_at = nowIso();
        entry.archive_reason = 'expired';
        this.archive.push(entry);
        moved = true;
      } else {
        kept.push(entry);
      }
    }
    if (moved) { this.entries = kept; this.save(); }
  }

  /**
   * The desktop app writes to the same file. Before answering anything, the
   * dashboard notices a file that changed on disk and picks the new entries up —
   * otherwise an answer taught in the desktop app would be invisible here until
   * a restart, which is exactly what "the same knowledge base" must not mean.
   */
  private reloadIfChanged(): void {
    try {
      const stat = fs.existsSync(this.path) ? fs.statSync(this.path) : null;
      const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : '';
      if (stamp === this.lastStamp) return;
      if (!stat) { this.lastStamp = ''; return; }
      this.lastStamp = stamp;
      const data = this.readFile();
      if (!data) return;
      const onDiskEntries = Array.isArray(data.entries) ? data.entries : [];
      const mine = new Map(this.entries.map((e) => [String(e.id), e]));
      const archived = this.archivedIds();
      const merged: KnowledgeEntry[] = [];
      for (const theirs of onDiskEntries) {
        if (archived.has(String(theirs.id))) continue;             // superseded here: not re-activated
        const ours = mine.get(String(theirs.id));
        if (!ours) { merged.push(theirs); continue; }
        const newer = String(ours.last_used || ours.created) >= String(theirs.last_used || theirs.created) ? ours : theirs;
        merged.push(newer);
        mine.delete(String(theirs.id));
      }
      mine.forEach((e) => merged.push(e));
      this.entries = merged;
      this.nextId = Math.max(this.nextId, Number(data.next_id) || 1);
      const theirsArchive = Array.isArray(data.archive) ? data.archive : [];
      if (theirsArchive.length) {
        const seen = new Set(this.archive.map((e) => `${e.id}:${e.archived_at || ''}`));
        for (const e of theirsArchive) if (!seen.has(`${e.id}:${e.archived_at || ''}`)) this.archive.push(e);
      }
    } catch { /* a file being written right now is read on the next call */ }
  }

  /**
   * A hash-verified copy of the older file, taken before the first version 2 write.
   *
   * The Persistent Brain makes a verified backup set before it rewrites a store; the
   * knowledge file gets the same treatment when its shape first changes. The upgrade
   * only ADDS a field — every entry and archive row is carried over — so a backup that
   * cannot be made is warned about and the save continues rather than losing an answer.
   */
  private backupBeforeUpgrade(): void {
    try {
      const backupDir = path.join(path.dirname(this.path), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const before = fs.readFileSync(this.path);
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
      const stem = path.basename(this.path, path.extname(this.path));
      const name = `${stem}.v1-${stamp}-${crypto.randomBytes(4).toString('hex')}.json`;
      const copy = path.join(backupDir, name);
      fs.writeFileSync(copy, before, { mode: 0o600 });
      const digest = crypto.createHash('sha256').update(before).digest('hex');
      const copied = crypto.createHash('sha256').update(fs.readFileSync(copy)).digest('hex');
      const after = crypto.createHash('sha256').update(fs.readFileSync(this.path)).digest('hex');
      if (digest !== copied || digest !== after) {
        fs.rmSync(copy, { force: true });
        console.warn('[knowledge] the file changed while its backup was being checked; the backup was removed');
        return;
      }
      fs.writeFileSync(path.join(backupDir, `${stem}.v1-${stamp}.manifest.json`),
        JSON.stringify({ created: stamp, source: path.basename(this.path), backup: name, sha256: digest,
          size_bytes: before.length,
          reason: 'taken before the knowledge file was first written in schema version 2' }, null, 2), { mode: 0o600 });
      console.log(`[knowledge] backed up the version 1 store as ${name} before the version 2 upgrade`);
    } catch (err) {
      console.warn('[knowledge] could not make a verified backup before the version 2 upgrade:',
        err instanceof Error ? err.message : err);
    }
  }

  /**
   * Ids this store has archived itself. The merge with the file on disk must not
   * re-activate one of these: a superseded answer stays superseded.
   */
  private archivedIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.archive) ids.add(String(entry.id));
    return ids;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const data = this.readFile();
    if (data) {
      this.entries = Array.isArray(data.entries) ? data.entries : [];
      this.archive = Array.isArray(data.archive) ? data.archive : [];
      this.nextId = Number.isFinite(Number(data.next_id)) && Number(data.next_id) > 0 ? Number(data.next_id) : 1;
      for (const e of [...this.entries, ...this.archive]) if (e.key) this.starterKeys.add(e.key);
    }
    this.addMissingStarters();
  }

  private readFile(): KnowledgeFile | null {
    if (!fs.existsSync(this.path)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.path, 'utf-8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
      return data as KnowledgeFile;
    } catch (err) {
      // Keep the damaged file aside and start again — nothing is lost, and the
      // next save never writes over what was there.
      const bad = `${this.path}.bad-${Date.now()}`;
      try { fs.renameSync(this.path, bad); } catch { /* readable-only: ignore */ }
      this.lastProblem = `runtime/knowledge.json could not be read (${err instanceof Error ? err.message : err}); it was kept as ${path.basename(bad)} and the store started again.`;
      console.warn(`[knowledge] ${this.lastProblem}`);
      return null;
    }
  }

  private readStarters(): Array<{ key?: string; question?: string; answer?: string }> {
    try {
      const items = JSON.parse(fs.readFileSync(this.starterPath, 'utf-8'));
      return Array.isArray(items) ? items.filter((i) => i && typeof i === 'object') : [];
    } catch {
      return [];
    }
  }

  private addMissingStarters(): void {
    let added = false;
    for (const item of this.readStarters()) {
      const key = `starter:${item.key || ''}`;
      if (!item.key || !item.question || !item.answer || this.starterKeys.has(key)) continue;
      this.starterKeys.add(key);
      this.entries.push({
        id: this.nextId, kind: 'starter', key,
        question: item.question, keywords: keywords(item.question), answer: item.answer,
        created: nowIso(), last_used: '', uses: 0, expires: '',
      });
      this.nextId += 1;
      added = true;
    }
    if (added) this.save();
  }

  /**
   * Written atomically, and merged with whatever the engine room has written in
   * the meantime: the dashboard re-reads the file, keeps the newer version of
   * any entry it also holds, and adds anything it has not seen. Both halves can
   * therefore use the store at the same time without losing an answer.
   */
  private save(): void {
    const tmp = `${this.path}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const onDisk = fs.existsSync(this.path) ? (() => {
        try { return JSON.parse(fs.readFileSync(this.path, 'utf-8')) as KnowledgeFile; } catch { return null; }
      })() : null;

      if (onDisk && Number(onDisk.version || 1) < KNOWLEDGE_VERSION) this.backupBeforeUpgrade();

      if (onDisk && Array.isArray(onDisk.entries)) {
        const mine = new Map(this.entries.map((e) => [String(e.id), e]));
        const archived = this.archivedIds();
        const merged: KnowledgeEntry[] = [];
        for (const theirs of onDisk.entries) {
          if (archived.has(String(theirs.id))) continue;           // superseded here: not re-activated
          const ours = mine.get(String(theirs.id));
          if (!ours) { merged.push(theirs); continue; }           // written by the other half: keep it
          const newer = String(ours.last_used || ours.created) >= String(theirs.last_used || theirs.created) ? ours : theirs;
          merged.push(newer);
          mine.delete(String(theirs.id));
        }
        mine.forEach((e) => merged.push(e));
        this.entries = merged;
        this.nextId = Math.max(this.nextId, Number(onDisk.next_id) || 1);
        const theirsArchive = Array.isArray(onDisk.archive) ? onDisk.archive : [];
        if (theirsArchive.length) {
          const seen = new Set(this.archive.map((e) => `${e.id}:${e.archived_at || ''}`));
          for (const e of theirsArchive) if (!seen.has(`${e.id}:${e.archived_at || ''}`)) this.archive.push(e);
        }
      }

      const payload: KnowledgeFile = { version: KNOWLEDGE_VERSION, entries: this.entries, archive: this.archive, next_id: this.nextId };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.path);
      try {
        const stat = fs.statSync(this.path);
        this.lastStamp = `${stat.mtimeMs}:${stat.size}`;
      } catch { this.lastStamp = ''; }
    } catch (err) {
      console.warn('[knowledge] could not save runtime/knowledge.json:', err instanceof Error ? err.message : err);
    }
  }
}
