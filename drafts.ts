/* JARVIS — the local drafting desk.
 * ============================================================================
 * The owner's rule: the AI is for knowledge and research. Drafting an email, a
 * letter or a note is a job the computer can do itself, so it does — here, with
 * no Gemini call and no cost. This is the file that answers
 *
 *     draft an email to the plumber about the leak
 *     write a short note to Sarah thanking her
 *     read my drafts
 *     read draft 2
 *     delete draft 1
 *
 * What it produces is a *first draft built from the owner's own words*: a proper
 * letter shape (greeting, opening, the ask, a closing, his name and the date)
 * with the subject he gave it. It never invents facts about people: where a
 * detail is missing the draft says so in brackets, so nothing reads as if the
 * assistant made it up. Every draft is written to runtime/drafts/ (kept on this
 * computer, git-ignored) and listed in an index, so "read draft 2" works later
 * and so the file can be opened in any editor.
 */
import fs from 'fs';
import path from 'path';

export type DraftKind = 'email' | 'letter' | 'note' | 'memo';

export interface Draft {
  id: number;
  kind: DraftKind;
  to: string;
  subject: string;
  text: string;
  file: string;
  created: string;
  /** Added for the structured Email workspace; older drafts remain valid. */
  cc?: string;
  bcc?: string;
  body?: string;
  updated?: string;
}

export interface EmailDraftFields {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

export type EmailDraftPatch = Partial<EmailDraftFields>;

export interface DraftRequest {
  kind: DraftKind;
  to: string;
  topic: string;
  subject: string;
  tone: 'plain' | 'friendly' | 'formal' | 'firm' | 'apologetic';
  brief: boolean;
}

const KIND_WORDS: Array<[RegExp, DraftKind]> = [
  [/\be-?mails?\b/i, 'email'],
  [/\bletters?\b/i, 'letter'],
  [/\bmemos?\b/i, 'memo'],
  [/\b(?:notes?|messages?|sms|whatsapps?)\b/i, 'note'],
];

const TONES: Array<[RegExp, DraftRequest['tone']]> = [
  [/\b(?:apolog(?:y|ise|ize|etic)|sorry)\b/i, 'apologetic'],
  [/\b(?:firm|stern|serious|strongly|urgency|urgent)\b/i, 'firm'],
  [/\b(?:formal|officially|professional|business)\b/i, 'formal'],
  [/\b(?:friendly|warm|kind|thanks|thank you|nice)\b/i, 'friendly'],
];

/** "draft me an email to X about Y", "write a short note to X saying Y" … */
export function parseDraftRequest(text: string): DraftRequest | null {
  const trimmed = text.trim().replace(/[.!?]+$/, '');
  const head = trimmed.match(
    /^(?:please\s+)?(?:jarvis,?\s+)?(?:draft|write|compose|prepare|make)\s+(?:me\s+)?(?:an?\s+)?(?:(?:short|quick|brief|detailed|formal|friendly|firm|kind|stern|polite)\s+)*(email|e-mail|letter|note|memo|message|sms|whatsapp)\b(.*)$/i
  );
  if (!head) return null;

  const kindWord = head[1].toLowerCase();
  const kind: DraftKind =
    /mail/.test(kindWord) ? 'email' : /letter/.test(kindWord) ? 'letter' : /memo/.test(kindWord) ? 'memo' : 'note';

  let rest = head[2].trim();
  let to = '';
  let topic = '';

  // "to <someone>" first, then whatever is left is the topic.
  const split = '(?:about|regarding|re\\b|saying|to say|that)';
  const toMatch = rest.match(new RegExp(`^(?:to|for)\\s+([^,]+?)(?:\\s+${split}\\s+([\\s\\S]*))?$`, 'i'));
  if (toMatch) {
    to = toMatch[1].trim();
    topic = (toMatch[2] || '').trim();
  } else {
    const aboutOnly = rest.match(/^(?:about|regarding|saying|to say)\s+([\s\S]*)$/i);
    topic = aboutOnly ? aboutOnly[1].trim() : rest;
  }

  // "to Sarah thanking her for the help": the doing-word belongs to the TOPIC,
  // not to the name — the whole point of it is that it becomes a real sentence
  // ("I am writing to thank you for the help"), so it is put back where it
  // belongs instead of being swallowed by the split above.
  if (!topic) {
    const doingWord = to.match(
      /^(.*?)\s+((?:thanking|to thank|asking|to ask|confirming|to confirm|inviting|to invite|requesting|reminding|to remind|following up)\b[\s\S]*)$/i
    );
    if (doingWord) {
      to = doingWord[1].trim();
      topic = doingWord[2].trim();
    }
  }

  // A stray "about" left over from "to X, about Y".
  topic = topic.replace(/^(?:about|regarding|saying|to say)\s+/i, '').trim();
  to = to.replace(/^(?:the|my)\s+/i, (m) => m).replace(/\s+about.*$/i, '').trim();
  if (!to && !topic) return null;

  let tone: DraftRequest['tone'] = 'plain';
  for (const [re, t] of TONES) if (re.test(trimmed)) { tone = t; break; }
  if (/\b(?:short|brief|quick|few lines)\b/i.test(trimmed) && tone === 'plain') tone = 'plain';

  const brief = /\b(?:short|brief|quick|few lines|one paragraph)\b/i.test(trimmed);
  const subject = toSubject(topic, kind);
  return { kind, to, topic, subject, tone, brief };
}

/** The subject line: the owner's own words, tidied, never a canned phrase. */
export function toSubject(topic: string, kind: DraftKind): string {
  const clean = topic.replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
  if (!clean) return kind === 'email' ? '(no subject yet — say what it is about)' : '';
  const short = clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
  const tidy = short
    .replace(/^thanking\s+(?:you|him|her|them)?\s*/i, 'Thanks ')
    .replace(/^to thank\s+(?:you|him|her|them)?\s*/i, 'Thanks ');
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'draft'
  );
}

/** "the plumber" is a label, "Sipho" is a name: told apart, so both read right. */
function isGeneric(to: string): boolean {
  return /^(?:the|my|our|his|her|their|a|an)\b/i.test(to.trim());
}

function address(to: string): string {
  const clean = to.trim().replace(/[,.:;]+$/, '');
  if (!clean) return '';
  if (isGeneric(clean)) return clean.toLowerCase();
  return clean.replace(/\b([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * A note is usually about doing something for the reader — thanking, asking,
 * confirming. Those verbs are turned into a sentence that reads like English,
 * with the owner's own tail left untouched:
 *   "thanking her for the help" -> "to thank you for the help"
 */
/** The person we are writing to is already "you": a leftover object pronoun is
    dropped, so "to thank him for the flowers" becomes "to thank you for the
    flowers" rather than "to thank you him for the flowers". */
function withoutObject(tail: string): string {
  const clean = tail.replace(/^(?:you|him|her|them|it|us)\b[\s,]*/i, '').trim();
  return clean ? ` ${clean}` : '';
}

const INTENT_VERBS: Array<[RegExp, (tail: string) => string]> = [
  [/^thanking\b[\s,]*/i, (t) => `to thank you${withoutObject(t)}`],
  [/^to thank\b[\s,]*/i, (t) => `to thank you${withoutObject(t)}`],
  [/^asking\b[\s,]*/i, (t) => `to ask you${withoutObject(t)}`],
  [/^to ask\b[\s,]*/i, (t) => `to ask you${withoutObject(t)}`],
  [/^confirming\b[\s,]*/i, (t) => `to confirm${withoutObject(t)}`],
  [/^to confirm\b[\s,]*/i, (t) => `to confirm${withoutObject(t)}`],
  [/^inviting\b[\s,]*/i, (t) => `to invite you${withoutObject(t)}`],
  [/^to invite\b[\s,]*/i, (t) => `to invite you${withoutObject(t)}`],
  [/^requesting\b[\s,]*/i, (t) => `to ask you${withoutObject(t)}`],
  [/^reminding\b[\s,]*/i, (t) => `to remind you${withoutObject(t)}`],
  [/^to remind\b[\s,]*/i, (t) => `to remind you${withoutObject(t)}`],
  [/^following up\b[\s,]*/i, (t) => `to follow up${withoutObject(t)}`],
];

function intentClause(topic: string): string | null {
  const clean = topic.trim();
  if (!clean) return null;
  for (const [re, build] of INTENT_VERBS) {
    const m = clean.match(re);
    if (m) return build(clean.slice(m[0].length).trim());
  }
  return null;
}

function greeting(to: string, tone: DraftRequest['tone'], kind: DraftKind): string {
  if (!to) return kind === 'memo' ? 'To: all concerned,' : 'Hello,';
  const who = address(to);
  // "Dear the plumber" is not something anyone writes: an unnamed trade or
  // office gets the ordinary English greeting instead.
  if (isGeneric(to)) return tone === 'formal' ? 'Dear Sir or Madam,' : 'Hello,';
  if (tone === 'formal') return `Dear ${who},`;
  if (tone === 'friendly') return `Hi ${who},`;
  return `Dear ${who},`;
}

function closing(tone: DraftRequest['tone'], userName: string): string {
  const sign = userName || 'Me';
  if (tone === 'formal') return `Yours sincerely,\n${sign}`;
  if (tone === 'friendly') return `Warm regards,\n${sign}`;
  if (tone === 'firm') return `Regards,\n${sign}`;
  if (tone === 'apologetic') return `With apologies,\n${sign}`;
  return `Regards,\n${sign}`;
}

type Intent = string | null;

function opener(tone: DraftRequest['tone'], topic: string, intent: Intent): string {
  // The topic is said ONCE, and said well: "I am writing to thank you for the
  // help" rather than "I am writing about thanking her for the help".
  const about = intent ? intent : topic ? `about ${topic}` : '';
  switch (tone) {
    case 'apologetic':
      return `I owe you an apology${about ? ` — I am writing ${about}` : ''}.`;
    case 'firm':
      return `I need to be clear${about ? ` ${about}` : ''}, and I would rather put it in writing than leave it unsaid.`;
    case 'formal':
      return `I am writing${about ? ` ${about}` : ''}.`;
    case 'friendly':
      return `I hope you are well. I am writing${about ? ` ${about}` : ''}.`;
    default:
      return `I am writing${about ? ` ${about}` : ''}.`;
  }
}

/** The placeholders: they say exactly what the owner has to add, and no fact is
    invented to fill the gap. */
function middle(tone: DraftRequest['tone']): string {
  switch (tone) {
    case 'apologetic':
      return `That was not what I intended, and I would like to put it right. [Say here what happened, in one or two lines, and what you are doing about it.]`;
    case 'firm':
      return `[State plainly what is wrong, what you need, and by when — one line each.] I would appreciate your answer in writing.`;
    case 'formal':
      return `[Add the reference, the date or the account number here if there is one.] I would be grateful for your reply by return.`;
    case 'friendly':
      return `[Add the one detail they need here — a date, a time, an amount.] No rush at all; whenever it suits you.`;
    default:
      return `[Add the detail they will need here: what you want, when, and anything they must bring or send.]`;
  }
}

function ask(tone: DraftRequest['tone'], topic: string, intent: Intent): string {
  if (intent && /^to thank/.test(intent)) return 'Thank you again — it is appreciated more than you know.';
  if (intent && /^to invite/.test(intent)) return 'It would be good to have you there. Let me know either way.';
  if (intent && /^to remind/.test(intent)) return 'Just a nudge, in case it slipped your mind.';
  if (intent && /^to confirm/.test(intent)) return 'Please confirm when you can.';
  const gist = topic || 'this';
  switch (tone) {
    case 'apologetic':
      return `Would you let me know if that is all right with you? I would rather fix ${gist} than leave it as it is.`;
    case 'firm':
      return `Please confirm in writing that this will be dealt with.`;
    case 'formal':
      return `Please let me know how you wish to proceed.`;
    case 'friendly':
      return `Could you let me know what works for you?`;
    default:
      return `Could you let me know how you would like to take this forward?`;
  }
}

/** Build the draft. Deterministic: the same words always give the same draft. */
export function composeDraft(req: DraftRequest, userName: string, now: Date = new Date()): string {
  const who = address(req.to);
  const date = now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const head: string[] = [];

  if (req.kind === 'email') {
    if (who) head.push(`To: ${who}`);
    if (req.subject) head.push(`Subject: ${req.subject}`);
  } else if (req.kind === 'memo') {
    head.push('MEMORANDUM');
    if (who) head.push(`To: ${who}`);
    head.push(`From: ${userName || 'Me'}`);
    head.push(`Date: ${date}`);
    if (req.subject) head.push(`Subject: ${req.subject}`);
  } else if (req.kind === 'letter') {
    head.push(date);
    if (who) head.push(who);
    if (req.subject) head.push(`Re: ${req.subject}`);
  } else if (req.subject) {
    head.push(`Re: ${req.subject}`);
  }

  const intent = intentClause(req.topic);
  const body: string[] = [];
  if (req.kind !== 'memo') body.push(greeting(req.to, req.tone, req.kind));
  body.push(opener(req.tone, req.topic, intent));
  if (!req.brief) body.push(middle(req.tone));
  body.push(ask(req.tone, req.topic, intent));
  body.push(closing(req.tone, userName));

  const parts = [head.join('\n'), body.join('\n\n')].filter((p) => p.trim());
  return `${parts.join('\n\n')}\n`;
}

const EMAIL_FIELD_LIMITS: Record<keyof EmailDraftFields, number> = {
  to: 2000, cc: 2000, bcc: 2000, subject: 998, body: 100_000,
};
const EMAIL_HEADER_FIELDS: Array<keyof EmailDraftFields> = ['to', 'cc', 'bcc', 'subject'];
const DRAFT_KINDS: DraftKind[] = ['email', 'letter', 'note', 'memo'];

function validDraftId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0;
}

/** Keep the author's body intact; remove only the old local desk's own headers. */
export function emailFieldsFromDraft(draft: Draft): EmailDraftFields {
  return {
    to: typeof draft.to === 'string' ? draft.to : '',
    cc: typeof draft.cc === 'string' ? draft.cc : '',
    bcc: typeof draft.bcc === 'string' ? draft.bcc : '',
    subject: typeof draft.subject === 'string' ? draft.subject : '',
    body: typeof draft.body === 'string' ? draft.body : extractLegacyEmailBody(draft.text),
  };
}

function extractLegacyEmailBody(text: string): string {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const divider = normalized.indexOf('\n\n');
  if (divider < 0) return normalized;
  const heading = normalized.slice(0, divider).split('\n');
  const onlyOldHeaders = heading.length > 0 && heading.every((line) => /^(?:to|cc|bcc|subject):\s*/i.test(line));
  return onlyOldHeaders ? normalized.slice(divider + 2) : normalized;
}

/** Render the plain-text companion file without changing the structured body. */
export function renderEmailDraftText(fields: EmailDraftFields): string {
  const headers: string[] = [];
  if (fields.to) headers.push(`To: ${fields.to}`);
  if (fields.cc) headers.push(`Cc: ${fields.cc}`);
  if (fields.bcc) headers.push(`Bcc: ${fields.bcc}`);
  if (fields.subject) headers.push(`Subject: ${fields.subject}`);
  return `${headers.length ? `${headers.join('\n')}\n\n` : ''}${fields.body}`;
}

function normalizeEmailFields(fields: EmailDraftFields): EmailDraftFields {
  const clean = { ...fields };
  for (const field of Object.keys(EMAIL_FIELD_LIMITS) as Array<keyof EmailDraftFields>) {
    const value = clean[field];
    if (typeof value !== 'string') throw new TypeError(`${field} must be text`);
    if (value.length > EMAIL_FIELD_LIMITS[field]) throw new RangeError(`${field} is too long`);
    if (value.includes('\0')) throw new TypeError(`${field} contains an invalid character`);
    if (EMAIL_HEADER_FIELDS.includes(field)) {
      if (/[\r\n]/.test(value)) throw new TypeError(`${field} must be a single line`);
      clean[field] = value.trim();
    }
  }
  return clean;
}

export interface ParsedEmailDraftEdit {
  id: number;
  field: keyof EmailDraftFields;
  value: string;
  mode: 'set' | 'append';
}

/** A deliberately explicit, local-only voice/typed edit; never guesses an ID or field. */
export function parseEmailDraftEdit(text: string): ParsedEmailDraftEdit | null {
  const trimmed = text.trim();
  const direct = trimmed.match(
    /^(?:please\s+)?(?:change|set|update|edit|replace)\s+(?:the\s+)?(recipient|to|cc|bcc|subject|body)\s+(?:field\s+)?(?:of\s+)?draft\s*(?:number\s*)?#?(\d+)\s+(?:to|as|with)\s+([\s\S]+)$/i
  ) || trimmed.match(
    /^(?:please\s+)?(?:change|set|update|edit|replace)\s+draft\s*(?:number\s*)?#?(\d+)\s+(recipient|to|cc|bcc|subject|body)\s+(?:to|as|with)\s+([\s\S]+)$/i
  );
  if (direct) {
    const reverse = /^\s*(?:please\s+)?(?:change|set|update|edit|replace)\s+draft\b/i.test(trimmed);
    const fieldWord = (reverse ? direct[2] : direct[1]).toLowerCase();
    const id = Number(reverse ? direct[1] : direct[2]);
    const value = direct[3];
    const field: keyof EmailDraftFields = fieldWord === 'recipient' ? 'to' : fieldWord as keyof EmailDraftFields;
    if (!validDraftId(id) || !value.trim()) return null;
    return { id, field, value, mode: 'set' };
  }

  const append = trimmed.match(
    /^(?:please\s+)?append\s+([\s\S]+?)\s+to\s+(?:the\s+)?body\s+of\s+draft\s*(?:number\s*)?#?(\d+)$/i
  );
  if (append) {
    const id = Number(append[2]);
    if (!validDraftId(id) || !append[1].trim()) return null;
    return { id, field: 'body', value: append[1], mode: 'append' };
  }
  return null;
}

export class DraftDesk {
  private readonly dir: string;
  private readonly file: string;
  private drafts: Draft[] = [];
  private indexUnsafe = false;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'index.json');
  }

  /**
   * Read old and new indexes. Invalid JSON is moved aside, and invalid rows are
   * backed up before being skipped, so a later save cannot silently erase them.
   */
  load(): Draft[] {
    this.drafts = [];
    if (!fs.existsSync(this.file)) return this.list();

    try {
      if (fs.lstatSync(this.file).isSymbolicLink()) throw new Error('index may not be a symbolic link');
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list: unknown = Array.isArray(raw) ? raw : Array.isArray(raw?.drafts) ? raw.drafts : null;
      if (!Array.isArray(list)) throw new Error('index must be an array of drafts');

      const valid: Draft[] = [];
      const ids = new Set<number>();
      let skipped = false;
      for (const value of list) {
        const draft = this.normalizeLoadedDraft(value);
        if (!draft || ids.has(draft.id)) { skipped = true; continue; }
        ids.add(draft.id);
        valid.push(draft);
      }
      if (skipped && !this.backupIndex('recovered')) this.indexUnsafe = true;
      this.drafts = valid;
      return this.list();
    } catch (err) {
      const preserved = this.quarantineIndex();
      if (!preserved) this.indexUnsafe = true;
      console.warn('[JARVIS] drafts index could not be read; its original was preserved' +
        (preserved ? ' and the desk starts empty:' : ' (backup could not be made; writes are disabled):'), (err as Error).message);
      this.drafts = [];
      return this.list();
    }
  }

  list(): Draft[] {
    return this.drafts.map((draft) => ({ ...draft }));
  }

  get(id: number): Draft | null {
    if (!validDraftId(id)) return null;
    const draft = this.drafts.find((item) => item.id === id);
    return draft ? { ...draft } : null;
  }

  getEmail(id: number): Draft | null {
    const draft = this.get(id);
    return draft?.kind === 'email' ? draft : null;
  }

  searchEmailDrafts(query = ''): Draft[] {
    const needle = String(query).trim().toLocaleLowerCase();
    return this.drafts
      .filter((draft) => draft.kind === 'email')
      .filter((draft) => !needle || [draft.to, draft.cc, draft.bcc, draft.subject,
        typeof draft.body === 'string' ? draft.body : extractLegacyEmailBody(draft.text)]
        .join('\n').toLocaleLowerCase().includes(needle))
      .map((draft) => ({ ...draft }));
  }

  nextId(): number {
    const next = this.drafts.reduce((max, draft) => Math.max(max, draft.id), 0) + 1;
    if (!validDraftId(next)) throw new RangeError('No safe draft IDs remain');
    return next;
  }

  /** Existing plain-text desk API: keeps letters, notes and memos compatible. */
  keep(req: DraftRequest, text: string, userName: string, now: Date = new Date()): Draft {
    const stamp = now.toISOString();
    const draft: Draft = {
      id: this.nextId(),
      kind: req.kind,
      to: req.to || '',
      subject: req.subject || '',
      text,
      file: '',
      created: stamp,
      updated: stamp,
    };
    if (req.kind === 'email') {
      const fields = normalizeEmailFields({
        to: req.to || '', cc: '', bcc: '', subject: req.subject || '', body: extractLegacyEmailBody(text),
      });
      Object.assign(draft, fields);
    }
    return this.persistNewDraft(draft, userName, now);
  }

  createEmail(fields: EmailDraftFields, userName = '', now: Date = new Date()): Draft {
    const clean = normalizeEmailFields(fields);
    const stamp = now.toISOString();
    const draft: Draft = {
      id: this.nextId(), kind: 'email', ...clean,
      text: renderEmailDraftText(clean), file: '', created: stamp, updated: stamp,
    };
    return this.persistNewDraft(draft, userName, now);
  }

  updateEmailDraft(id: number, patch: EmailDraftPatch, userName = '', now: Date = new Date()): Draft | null {
    const current = this.getEmail(id);
    if (!current) return null;
    const allowed = new Set<keyof EmailDraftFields>(['to', 'cc', 'bcc', 'subject', 'body']);
    for (const key of Object.keys(patch) as Array<keyof EmailDraftPatch>) {
      if (!allowed.has(key) || typeof patch[key] !== 'string') throw new TypeError(`Invalid email draft field: ${key}`);
    }
    const clean = normalizeEmailFields({ ...emailFieldsFromDraft(current), ...patch });
    const stamp = now.toISOString();
    const nextDraft: Draft = {
      ...current, ...clean, text: renderEmailDraftText(clean), updated: stamp,
    };
    let target = current.file ? this.safeDraftFilePath(current.file) : null;
    if (current.file && !target) throw new Error('Draft file path is outside the local drafts folder; it was not changed.');
    if (!target) {
      fs.mkdirSync(this.dir, { recursive: true });
      target = this.newDraftFilePath(current.id, current.kind, current.to || current.subject, now);
      nextDraft.file = path.relative(process.cwd(), target);
    }

    const priorContents = this.readRegularDraftFile(target);
    this.writeAtomic(target, this.fileContents(nextDraft, userName));
    const nextDrafts = this.drafts.map((draft) => draft.id === id ? nextDraft : draft);
    try {
      this.writeIndex(nextDrafts);
    } catch (err) {
      try {
        if (priorContents === null) fs.unlinkSync(target);
        else this.writeAtomic(target, priorContents);
      } catch (rollbackError) {
        console.error('[JARVIS] draft file rollback failed after an index save error:', (rollbackError as Error).message);
      }
      throw err;
    }
    this.drafts = nextDrafts;
    return { ...nextDraft };
  }

  duplicateEmail(id: number, userName = '', now: Date = new Date()): Draft | null {
    const source = this.getEmail(id);
    if (!source) return null;
    return this.createEmail(emailFieldsFromDraft(source), userName, now);
  }

  /** Remove the index entry and its file as one recoverable operation. */
  forget(id: number): Draft | null {
    if (!validDraftId(id)) return null;
    const index = this.drafts.findIndex((draft) => draft.id === id);
    if (index < 0) return null;
    const gone = this.drafts[index];
    const source = gone.file ? this.safeDraftFilePath(gone.file) : null;
    if (gone.file && !source) throw new Error('Draft file path is outside the local drafts folder; nothing was deleted.');

    let tombstone: string | null = null;
    if (source && fs.existsSync(source)) {
      this.readRegularDraftFile(source); // reject directories and symbolic links
      tombstone = path.join(this.dir, `.delete-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      fs.renameSync(source, tombstone);
    }

    const nextDrafts = this.drafts.filter((draft) => draft.id !== id);
    try {
      this.writeIndex(nextDrafts);
    } catch (err) {
      if (tombstone) {
        try { fs.renameSync(tombstone, source!); }
        catch (rollbackError) { console.error('[JARVIS] draft deletion rollback failed:', (rollbackError as Error).message); }
      }
      throw err;
    }
    this.drafts = nextDrafts;
    if (tombstone) {
      try { fs.unlinkSync(tombstone); }
      catch (err) { console.warn('[JARVIS] deleted draft left a cleanup file:', (err as Error).message); }
    }
    return { ...gone };
  }

  private normalizeLoadedDraft(value: unknown): Draft | null {
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== 'number' || !validDraftId(id) || !DRAFT_KINDS.includes(item.kind as DraftKind) || typeof item.text !== 'string') return null;
    const draft: Draft = {
      ...item,
      id,
      kind: item.kind as DraftKind,
      to: typeof item.to === 'string' ? item.to : '',
      subject: typeof item.subject === 'string' ? item.subject : '',
      text: item.text,
      file: typeof item.file === 'string' ? item.file : '',
      created: typeof item.created === 'string' ? item.created : new Date(0).toISOString(),
    } as Draft;
    if (typeof item.cc === 'string') draft.cc = item.cc;
    if (typeof item.bcc === 'string') draft.bcc = item.bcc;
    if (typeof item.body === 'string') draft.body = item.body;
    if (typeof item.updated === 'string') draft.updated = item.updated;
    return draft;
  }

  private persistNewDraft(draft: Draft, userName: string, now: Date): Draft {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.newDraftFilePath(draft.id, draft.kind, draft.to || draft.subject, now);
    draft.file = path.relative(process.cwd(), target);
    this.writeAtomic(target, this.fileContents(draft, userName));
    const nextDrafts = [...this.drafts, draft];
    try {
      this.writeIndex(nextDrafts);
    } catch (err) {
      try { fs.unlinkSync(target); } catch (_) { /* the original save error is more useful */ }
      throw err;
    }
    this.drafts = nextDrafts;
    return { ...draft };
  }

  private fileContents(draft: Draft, userName: string): string {
    const fields = draft.kind === 'email' ? emailFieldsFromDraft(draft) : null;
    const header = [
      'JARVIS local drafting desk — no AI was used to write this.',
      `Kind: ${draft.kind}`,
      `To: ${draft.to || '(nobody named)'}`,
      ...(fields?.cc ? [`Cc: ${fields.cc}`] : []),
      ...(fields?.bcc ? [`Bcc: ${fields.bcc}`] : []),
      `Subject: ${draft.subject || '(none)'}`,
      `Drafted: ${draft.created}`,
      `Last edited: ${draft.updated || draft.created}`,
      `Owner: ${userName || '(not set)'}`,
      '-'.repeat(64),
      '',
    ].join('\n');
    return header + draft.text;
  }

  private newDraftFilePath(id: number, kind: DraftKind, label: string, now: Date): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const unique = `${process.pid}-${Math.random().toString(36).slice(2, 9)}`;
    return path.join(this.dir, `${id}-${stamp}-${kind}-${slugify(label)}-${unique}.txt`);
  }

  private safeDraftFilePath(file: string): string | null {
    if (typeof file !== 'string' || !file || file.includes('\0')) return null;
    const resolved = path.resolve(path.isAbsolute(file) ? file : path.resolve(process.cwd(), file));
    const relative = path.relative(this.dir, resolved);
    // The existing desk writes one generated .txt file directly in its storage
    // directory. Reject nested paths too, so a symlinked child directory cannot
    // make a lexically-contained path escape to another location.
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) || relative.includes(path.sep)) return null;
    return resolved;
  }

  private readRegularDraftFile(file: string): string | null {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Draft storage path is not a regular file.');
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private writeAtomic(target: string, content: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
      throw err;
    }
  }

  private writeIndex(drafts: Draft[]): void {
    if (this.indexUnsafe) throw new Error('Draft index could not be backed up safely; no changes were written.');
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.index.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(drafts, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
      throw err;
    }
  }

  private quarantineIndex(): boolean {
    try {
      fs.renameSync(this.file, `${this.file}.bad-${Date.now()}`);
      return true;
    } catch (_) {
      return this.backupIndex('bad');
    }
  }

  private backupIndex(label: string): boolean {
    try {
      const backup = `${this.file}.${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
      return true;
    } catch (err) {
      console.warn('[JARVIS] could not make a backup of the original drafts index:', (err as Error).message);
      return false;
    }
  }
}
