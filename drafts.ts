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
}

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

export class DraftDesk {
  private readonly dir: string;
  private readonly file: string;
  private drafts: Draft[] = [];

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, 'index.json');
  }

  /** Read the index; a damaged file is kept (renamed) and the desk starts empty. */
  load(): Draft[] {
    try {
      if (!fs.existsSync(this.file)) { this.drafts = []; return this.drafts; }
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list: Draft[] = Array.isArray(raw) ? raw : Array.isArray(raw?.drafts) ? raw.drafts : [];
      this.drafts = list
        .filter((d) => d && typeof d === 'object' && typeof d.text === 'string')
        .map((d) => ({ ...d, id: Number(d.id) || 0 }));
      return this.drafts;
    } catch (err) {
      try { fs.renameSync(this.file, `${this.file}.bad-${Date.now()}`); } catch (_) { /* nothing to do */ }
      console.warn('[JARVIS] drafts index could not be read, starting a fresh one:', (err as Error).message);
      this.drafts = [];
      return this.drafts;
    }
  }

  list(): Draft[] {
    return this.drafts;
  }

  nextId(): number {
    return this.drafts.reduce((max, d) => Math.max(max, d.id), 0) + 1;
  }

  /** Write one draft: the file itself, and the index beside it. */
  keep(req: DraftRequest, text: string, userName: string, now: Date = new Date()): Draft {
    fs.mkdirSync(this.dir, { recursive: true });
    const id = this.nextId();
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = `${stamp}-${req.kind}-${slugify(req.to || req.subject)}.txt`;
    const file = path.join(this.dir, name);
    const header = `JARVIS local drafting desk — no AI was used to write this.\nKind: ${req.kind}\nTo: ${req.to || '(nobody named)'}\nSubject: ${req.subject || '(none)'}\nDrafted: ${now.toISOString()}\nOwner: ${userName || '(not set)'}\n${'-'.repeat(64)}\n\n`;
    fs.writeFileSync(file, header + text);
    const draft: Draft = {
      id,
      kind: req.kind,
      to: req.to,
      subject: req.subject,
      text,
      file: path.relative(process.cwd(), file),
      created: now.toISOString(),
    };
    this.drafts.push(draft);
    this.save();
    return draft;
  }

  forget(id: number): Draft | null {
    const index = this.drafts.findIndex((d) => d.id === id);
    if (index < 0) return null;
    const [gone] = this.drafts.splice(index, 1);
    try { fs.unlinkSync(path.join(process.cwd(), gone.file)); } catch (_) { /* already gone */ }
    this.save();
    return gone;
  }

  private save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.drafts, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[JARVIS] drafts index could not be saved:', (err as Error).message);
    }
  }
}
