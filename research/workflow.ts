import { fetchPublicPage, isSafePublicHttpUrl, ResearchFetchError } from './fetch.js';
import { composeReport, buildSynthesisPrompt, safeSourceUrl, type GroundedSearchInput } from './report.js';
import type { ResearchDocument, ResearchSource, ResearchTaskStatus, SourceFetchStatus } from './types.js';

export const MAX_RESEARCH_QUESTION_CHARS = 1_200;
export const MAX_GROUNDING_SOURCES = 8;
export const MAX_OPENED_PAGES = 3;
export const MAX_SEARCH_QUERIES = 8;

export type ResearchProgress = (status: ResearchTaskStatus, message: string) => void;

export interface ResearchServices {
  search(question: string): Promise<GroundedSearchInput>;
  synthesize(prompt: string): Promise<string>;
  fetchPage?: (url: string) => Promise<{
    finalUrl: string;
    title: string;
    publisher: string;
    publishedAt: string | null;
    excerpt: string;
    textLength: number;
  }>;
  safeUrl?: (url: string) => Promise<boolean>;
  now?: () => Date;
}

export class ResearchWorkflowError extends Error {
  code: 'invalid-question' | 'search-unavailable' | 'no-sources' | 'synthesis-unavailable';
  constructor(code: ResearchWorkflowError['code'], message: string) {
    super(message);
    this.name = 'ResearchWorkflowError';
    this.code = code;
  }
}

function sourceHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return 'Publisher not identified'; }
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value.replace(/\0/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function supportExcerpt(source: { supportTexts?: unknown }): string {
  const parts = Array.isArray(source.supportTexts) ? source.supportTexts : [];
  return parts.filter((part): part is string => typeof part === 'string').map((part) => boundedText(part, 1_800)).filter(Boolean).join(' ').slice(0, 1_800);
}

function pageDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function pageError(error: unknown): { status: SourceFetchStatus; note: string } {
  if (!(error instanceof ResearchFetchError)) return { status: 'unavailable', note: 'Page could not be accessed; only search-grounded evidence is available.' };
  if (error.code === 'unsafe-url') return { status: 'blocked', note: 'Blocked because the source was private, reserved, or did not resolve to a public network address.' };
  if (error.code === 'insufficient') return { status: 'insufficient', note: 'Page opened, but the extracted text was too limited to verify useful details.' };
  if (error.code === 'timeout') return { status: 'unavailable', note: 'Page could not be accessed before the 8-second timeout.' };
  if (error.code === 'too-large') return { status: 'unavailable', note: 'Page was not read because it exceeded the 1 MB response limit.' };
  if (error.code === 'bad-content-type') return { status: 'unavailable', note: 'Page was not read because it was not an accepted HTML or plain-text response.' };
  if (error.code === 'bad-status') return { status: 'unavailable', note: error.message.slice(0, 240) };
  return { status: 'unavailable', note: 'Page could not be safely parsed.' };
}

/** One grounded search call, a small set of bounded public-page extracts, and one cited synthesis. */
export async function runResearchWorkflow(
  rawQuestion: string,
  services: ResearchServices,
  progress: ResearchProgress = () => undefined,
): Promise<Omit<ResearchDocument, 'id' | 'createdAt' | 'updatedAt'>> {
  const question = typeof rawQuestion === 'string' ? rawQuestion.trim() : '';
  if (question.length < 8 || question.length > MAX_RESEARCH_QUESTION_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(question)) {
    throw new ResearchWorkflowError('invalid-question', `Enter a research question between 8 and ${MAX_RESEARCH_QUESTION_CHARS} characters.`);
  }

  progress('searching', 'Preparing a focused search plan and asking Google Search for grounded evidence…');
  let grounded: GroundedSearchInput;
  try { grounded = await services.search(question); }
  catch (error) {
    if (error instanceof ResearchWorkflowError) throw error;
    throw new ResearchWorkflowError('search-unavailable', 'Google Search grounding is unavailable for this request. Check the Gemini key, model access, quota, and Search grounding availability; no web search is being claimed.');
  }

  const accepted: Array<{ title: string; url: string; supportTexts?: unknown }> = [];
  let unsafeCount = 0;
  const seen = new Set<string>();
  const candidateSources = Array.isArray(grounded?.sources) ? grounded.sources.slice(0, MAX_GROUNDING_SOURCES) : [];
  const searchAnswer = boundedText(grounded?.answer, 12_000);
  const searchQueries = Array.isArray(grounded?.queries)
    ? grounded.queries.slice(0, MAX_SEARCH_QUERIES).map((query) => boundedText(query, 300)).filter(Boolean)
    : [];
  for (const item of candidateSources) {
    if (!item || typeof item !== 'object') { unsafeCount++; continue; }
    const url = safeSourceUrl(item.url);
    if (!url || seen.has(url)) { if (!url) unsafeCount++; continue; }
    seen.add(url);
    accepted.push({ title: boundedText(item.title, 300), url, supportTexts: item.supportTexts });
  }
  if (!accepted.length) {
    throw new ResearchWorkflowError('no-sources', 'The search provider returned no safe, traceable source links. No report was generated from model knowledge alone.');
  }

  progress('fetching', `Checking up to ${Math.min(MAX_OPENED_PAGES, accepted.length)} public source pages. The rest will be labelled as search-only.`);
  const safeUrl = services.safeUrl || isSafePublicHttpUrl;
  const checked = await Promise.all(accepted.map(async (entry) => ({ entry, safe: await safeUrl(entry.url).catch(() => false) })));
  const safeEntries = checked.filter((entry) => entry.safe).map((entry) => entry.entry);
  unsafeCount += checked.length - safeEntries.length;
  if (!safeEntries.length) {
    throw new ResearchWorkflowError('no-sources', 'Search returned links, but none resolved to a safe public address. They were not opened or reported as verified sources.');
  }

  const now = services.now || (() => new Date());
  const searchCheckedAt = now().toISOString();
  const sources: ResearchSource[] = safeEntries.map((entry, index) => ({
    id: `S${index + 1}`,
    title: entry.title.trim().slice(0, 300) || sourceHost(entry.url),
    publisher: sourceHost(entry.url),
    url: entry.url,
    fetchedUrl: null,
    publishedAt: null,
    searchCheckedAt,
    accessedAt: null,
    excerpt: '',
    searchExcerpt: supportExcerpt(entry),
    fetchStatus: 'not-opened',
    fetchNote: index < MAX_OPENED_PAGES ? '' : `Not opened: the per-task page-fetch limit is ${MAX_OPENED_PAGES}.`,
  }));

  const openPage = services.fetchPage || fetchPublicPage;
  const tasks = sources.slice(0, MAX_OPENED_PAGES).map(async (source) => {
    source.accessedAt = now().toISOString();
    try {
      const page = await openPage(source.url);
      const finalUrl = safeSourceUrl(page?.finalUrl);
      if (!finalUrl || !(await safeUrl(finalUrl).catch(() => false))) {
        throw new ResearchFetchError('unsafe-url', 'The final source address did not pass public-network validation.');
      }
      const excerpt = boundedText(page?.excerpt, 1_800);
      const textLength = Number(page?.textLength);
      if (excerpt.length < 160 || !Number.isFinite(textLength) || textLength < excerpt.length) {
        throw new ResearchFetchError('insufficient', 'The accessible page did not contain enough readable text to verify useful details.');
      }
      source.title = boundedText(page?.title, 300) || source.title;
      source.publisher = boundedText(page?.publisher, 200) || source.publisher;
      source.fetchedUrl = finalUrl;
      source.publishedAt = pageDate(page?.publishedAt);
      source.excerpt = excerpt;
      source.fetchStatus = 'read';
      source.fetchNote = `Read a bounded text extract (${Math.floor(textLength)} characters available); not a full-page review.`;
    } catch (error) {
      const result = pageError(error);
      source.fetchStatus = result.status;
      source.fetchNote = result.note;
      if (result.status === 'blocked') {
        // A DNS change between link validation and the pinned request makes the
        // original URL unsuitable for display as a clickable source.
        source.url = '';
        unsafeCount++;
      }
    }
  });
  await Promise.all(tasks);

  const filteredSources = sources.filter((source) => Boolean(source.url));
  if (!filteredSources.length) {
    throw new ResearchWorkflowError('no-sources', 'No source could be safely opened or cited. No report was generated.');
  }
  // Re-number after removing any URL blocked by a second, fresh DNS check.
  filteredSources.forEach((source, index) => { source.id = `S${index + 1}`; });
  const opened = filteredSources.filter((source) => source.fetchStatus === 'read').length;
  const limitations: string[] = [];
  if (unsafeCount) limitations.push(`${unsafeCount} search result link(s) were omitted because they were unsafe or could not be validated as public.`);
  if (opened === 0) limitations.push('No source page yielded readable text. Findings rely on Google grounding evidence only; no full webpages were read.');
  else if (filteredSources.some((source) => source.fetchStatus !== 'read')) limitations.push('Some source pages were inaccessible, unreadable, or not opened because of the page limit; those are labelled individually and their search-grounding notes are not direct page extracts.');
  if (filteredSources.some((source) => source.publishedAt === null)) limitations.push('Publication dates were not stated in some accessible pages; access dates are recorded separately.');

  progress('synthesizing', `Comparing evidence from ${filteredSources.length} traceable sources and preparing the report…`);
  let body: string;
  const groundedForPrompt: GroundedSearchInput = { answer: searchAnswer, queries: searchQueries, sources: accepted };
  try { body = await services.synthesize(buildSynthesisPrompt(question, groundedForPrompt, filteredSources)); }
  catch {
    throw new ResearchWorkflowError('synthesis-unavailable', 'Search sources were found, but the report writer was unavailable. The partial search results were not presented as a completed report.');
  }
  if (!body.trim()) throw new ResearchWorkflowError('synthesis-unavailable', 'The report writer returned no usable report text. The search results remain unverified.');

  const title = question.replace(/\s+/g, ' ').replace(/[?!.]+$/, '').slice(0, 120) || 'Research report';
  const result = composeReport({ question, title, body, sources: filteredSources, limitations, queries: searchQueries, now: now() });
  progress('complete', `Report ready: ${opened} source page extract(s), ${filteredSources.length} traceable source(s), ${searchQueries.length} provider query/queries reported.`);
  return result;
}
