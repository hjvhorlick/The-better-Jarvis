export type ResearchTaskStatus = 'queued' | 'searching' | 'fetching' | 'synthesizing' | 'complete' | 'failed';
export type SourceFetchStatus = 'read' | 'not-opened' | 'unavailable' | 'blocked' | 'insufficient';

export interface ResearchSource {
  id: string;
  title: string;
  publisher: string;
  url: string;
  fetchedUrl: string | null;
  publishedAt: string | null;
  searchCheckedAt: string;
  accessedAt: string | null;
  excerpt: string;
  searchExcerpt: string;
  fetchStatus: SourceFetchStatus;
  fetchNote: string;
}

export interface ResearchDocument {
  id: string;
  title: string;
  question: string;
  report: string;
  sources: ResearchSource[];
  searchQueries: string[];
  limitations: string[];
  provider: 'Gemini Google Search grounding';
  createdAt: string;
  updatedAt: string;
}

export interface ResearchTaskSnapshot {
  id: string;
  question: string;
  title: string;
  status: ResearchTaskStatus;
  progress: string;
  createdAt: string;
  updatedAt: string;
  report: ResearchDocument | null;
  savedReportId: string | null;
  error: string | null;
}
