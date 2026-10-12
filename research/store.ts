import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResearchDocument, ResearchSource } from './types.js';

export const DEFAULT_RESEARCH_DIR = path.join(process.cwd(), 'runtime', 'research');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_CHARS = 160;
const MAX_QUESTION_CHARS = 1_500;
const MAX_REPORT_CHARS = 24_000;
const MAX_SOURCES = 12;
const MAX_EXCERPT_CHARS = 1_800;

export class ResearchStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchStoreError';
  }
}

function cleanText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, limit) : '';
}

function cleanSource(value: unknown): ResearchSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = cleanText(item.id, 12);
  const url = cleanText(item.url, 2048);
  const fetchStatus = item.fetchStatus;
  if (!/^S\d{1,2}$/.test(id) || !url || (fetchStatus !== 'read' && fetchStatus !== 'not-opened' &&
      fetchStatus !== 'unavailable' && fetchStatus !== 'blocked' && fetchStatus !== 'insufficient')) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return null;
  const publishedAt = typeof item.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.publishedAt) ? item.publishedAt : null;
  const fetchedUrl = typeof item.fetchedUrl === 'string' && (item.fetchedUrl.startsWith('https://') || item.fetchedUrl.startsWith('http://'))
    ? item.fetchedUrl.slice(0, 2048) : null;
  return {
    id,
    title: cleanText(item.title, 300) || parsed.hostname,
    publisher: cleanText(item.publisher, 200) || parsed.hostname,
    url: parsed.toString(),
    fetchedUrl,
    publishedAt,
    searchCheckedAt: cleanText(item.searchCheckedAt, 40) || cleanText(item.accessedAt, 40) || new Date(0).toISOString(),
    accessedAt: typeof item.accessedAt === 'string' && item.accessedAt.trim() ? cleanText(item.accessedAt, 40) : null,
    excerpt: cleanText(item.excerpt, MAX_EXCERPT_CHARS),
    searchExcerpt: cleanText(item.searchExcerpt, MAX_EXCERPT_CHARS),
    fetchStatus,
    fetchNote: cleanText(item.fetchNote, 300),
  };
}

function normalizeDocument(value: unknown, id?: string): ResearchDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const reportId = id || cleanText(item.id, 36);
  if (!UUID.test(reportId)) return null;
  const title = cleanText(item.title, MAX_TITLE_CHARS);
  const question = cleanText(item.question, MAX_QUESTION_CHARS);
  const report = cleanText(item.report, MAX_REPORT_CHARS);
  const createdAt = cleanText(item.createdAt, 40);
  const updatedAt = cleanText(item.updatedAt, 40);
  const sources = Array.isArray(item.sources) ? item.sources.slice(0, MAX_SOURCES).map(cleanSource).filter((source): source is ResearchSource => Boolean(source)) : [];
  const searchQueries = Array.isArray(item.searchQueries)
    ? item.searchQueries.slice(0, 8).map((query) => cleanText(query, 300)).filter(Boolean)
    : [];
  const limitations = Array.isArray(item.limitations)
    ? item.limitations.slice(0, 20).map((entry) => cleanText(entry, 500)).filter(Boolean)
    : [];
  if (!title || !question || !report || report.length > MAX_REPORT_CHARS || !createdAt || !updatedAt || !sources.length) return null;
  return {
    id: reportId,
    title,
    question,
    report,
    sources,
    searchQueries,
    limitations,
    provider: 'Gemini Google Search grounding',
    createdAt,
    updatedAt,
  };
}

/** File-per-report storage: a malformed record cannot hide or overwrite the others. */
export class ResearchStore {
  readonly dir: string;
  lastProblem = '';

  constructor(dir = DEFAULT_RESEARCH_DIR) {
    this.dir = path.resolve(dir);
  }

  list(query = '', limit = 200): Array<Omit<ResearchDocument, 'report' | 'sources' | 'searchQueries' | 'limitations' | 'provider'> & { sourceCount: number }> {
    this.lastProblem = '';
    let names: string[];
    try { names = fs.readdirSync(this.dir); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      this.lastProblem = 'Saved research reports could not be listed.';
      return [];
    }
    const needle = cleanText(query, 200).toLowerCase();
    const out: Array<Omit<ResearchDocument, 'report' | 'sources' | 'searchQueries' | 'limitations' | 'provider'> & { sourceCount: number }> = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const id = name.slice(0, -5);
      const file = this.filePath(id);
      if (!file) continue;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) continue;
        const doc = normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf8')), id);
        if (!doc) { this.lastProblem = 'One malformed report was skipped and left untouched.'; continue; }
        const searchable = `${doc.title}\n${doc.question}\n${doc.report}\n${doc.searchQueries.join(' ')}\n${doc.limitations.join(' ')}\n${doc.sources.map((s) => `${s.title} ${s.publisher} ${s.url} ${s.excerpt} ${s.searchExcerpt}`).join('\n')}`;
        if (needle && !searchable.toLowerCase().includes(needle)) continue;
        out.push({
          id: doc.id, title: doc.title, question: doc.question,
          createdAt: doc.createdAt, updatedAt: doc.updatedAt, sourceCount: doc.sources.length,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.lastProblem = 'A saved report could not be read and was left untouched.';
      }
    }
    return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, Math.max(1, Math.min(200, limit)));
  }

  get(id: string): ResearchDocument | null {
    const file = this.filePath(id);
    if (!file) return null;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) return null;
      return normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf8')), id);
    } catch {
      return null;
    }
  }

  save(document: Omit<ResearchDocument, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<ResearchDocument, 'title'>>, now = new Date()): ResearchDocument {
    const timestamp = now.toISOString();
    const proposed = {
      ...document,
      id: randomUUID(),
      title: cleanText(document.title, MAX_TITLE_CHARS) || this.defaultTitle(document.question),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const normalized = normalizeDocument(proposed);
    if (!normalized) throw new ResearchStoreError('The completed report is incomplete or exceeds local storage limits.');
    this.write(normalized, false);
    return normalized;
  }

  rename(id: string, title: string, now = new Date()): ResearchDocument | null {
    const current = this.get(id);
    if (!current) return null;
    const cleanTitle = cleanText(title, MAX_TITLE_CHARS);
    if (!cleanTitle) throw new ResearchStoreError('A report title is required.');
    const updated = { ...current, title: cleanTitle, updatedAt: now.toISOString() };
    this.write(updated, true);
    return updated;
  }

  replace(id: string, content: Omit<ResearchDocument, 'id' | 'createdAt' | 'updatedAt'>, now = new Date()): ResearchDocument | null {
    const current = this.get(id);
    if (!current) return null;
    const updated = normalizeDocument({
      ...content,
      id,
      createdAt: current.createdAt,
      updatedAt: now.toISOString(),
      title: cleanText(content.title, MAX_TITLE_CHARS) || current.title,
    }, id);
    if (!updated) throw new ResearchStoreError('The refreshed report is incomplete or exceeds local storage limits.');
    this.write(updated, true);
    return updated;
  }

  delete(id: string): ResearchDocument | null {
    const file = this.filePath(id);
    if (!file) return null;
    let current: ResearchDocument | null;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ResearchStoreError('The report path is not a regular file; nothing was deleted.');
      current = normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf8')), id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof ResearchStoreError) throw err;
      return null;
    }
    if (!current) return null;
    fs.unlinkSync(file);
    return current;
  }

  private defaultTitle(question: string): string {
    const title = cleanText(question, MAX_TITLE_CHARS).replace(/[?!.]+$/, '');
    return title || 'Research report';
  }

  private filePath(id: string): string | null {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const file = path.resolve(this.dir, `${id}.json`);
    const relative = path.relative(this.dir, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) return null;
    return file;
  }

  private write(document: ResearchDocument, replace: boolean): void {
    const file = this.filePath(document.id);
    if (!file) throw new ResearchStoreError('Invalid report identifier.');
    fs.mkdirSync(this.dir, { recursive: true });
    if (replace) {
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new ResearchStoreError('The report path is not a regular file; nothing was overwritten.');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        throw new ResearchStoreError('The saved report could not be found.');
      }
    } else if (fs.existsSync(file)) {
      throw new ResearchStoreError('A report with this identifier already exists.');
    }
    const temp = path.join(this.dir, `.${document.id}.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(document, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (err) {
      try { fs.unlinkSync(temp); } catch { /* no temporary file to remove */ }
      throw err;
    }
  }
}
