import { randomUUID } from 'node:crypto';
import { ResearchStore, ResearchStoreError } from './store.js';
import type { ResearchDocument, ResearchTaskSnapshot, ResearchTaskStatus } from './types.js';

export class ResearchTasksError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ResearchTasksError';
    this.status = status;
  }
}

export type ResearchContent = Omit<ResearchDocument, 'id' | 'createdAt' | 'updatedAt'>;
export type TaskExecutor = (question: string, progress: (status: ResearchTaskStatus, message: string) => void) => Promise<ResearchContent>;

interface TaskRecord {
  id: string;
  question: string;
  title: string;
  status: ResearchTaskStatus;
  progress: string;
  createdAt: string;
  updatedAt: string;
  report: ResearchDocument | null;
  savedReportId: string | null;
  updateReportId: string | null;
  error: string | null;
}

function publicSnapshot(task: TaskRecord, includeReport: boolean): ResearchTaskSnapshot {
  return {
    id: task.id,
    question: task.question,
    title: task.title,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    report: includeReport ? task.report : null,
    savedReportId: task.savedReportId,
    error: task.error,
  };
}

export class ResearchTaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly execute: TaskExecutor;
  private readonly store: ResearchStore;
  private readonly now: () => Date;
  private readonly maxActive: number;
  private readonly maxRetained: number;

  constructor(options: {
    execute: TaskExecutor;
    store: ResearchStore;
    now?: () => Date;
    maxActive?: number;
    maxRetained?: number;
  }) {
    this.execute = options.execute;
    this.store = options.store;
    this.now = options.now || (() => new Date());
    this.maxActive = Math.max(1, options.maxActive ?? 2);
    this.maxRetained = Math.max(this.maxActive, options.maxRetained ?? 20);
  }

  start(question: string, updateReportId: string | null = null): ResearchTaskSnapshot {
    const clean = String(question || '').trim();
    if (clean.length < 8 || clean.length > 1_200) throw new ResearchTasksError('Enter a research question between 8 and 1,200 characters.', 400);
    if (updateReportId && !this.store.get(updateReportId)) throw new ResearchTasksError('The saved report to update could not be found.', 404);
    const active = [...this.tasks.values()].filter((task) => task.status !== 'complete' && task.status !== 'failed').length;
    if (active >= this.maxActive) throw new ResearchTasksError(`Research is at its limit of ${this.maxActive} active task(s). Wait for one to finish, then try again.`, 429);
    this.prune();
    if (this.tasks.size >= this.maxRetained) throw new ResearchTasksError('The recent-task list is full. Restart the Research workspace after saving any completed report.', 429);

    const now = this.now().toISOString();
    const task: TaskRecord = {
      id: randomUUID(),
      question: clean,
      title: updateReportId ? this.store.get(updateReportId)?.title || clean.slice(0, 120) : clean.slice(0, 120),
      status: 'queued',
      progress: 'Queued locally; no provider request has been made yet.',
      createdAt: now,
      updatedAt: now,
      report: null,
      savedReportId: updateReportId,
      updateReportId,
      error: null,
    };
    this.tasks.set(task.id, task);
    void this.run(task);
    return publicSnapshot(task, false);
  }

  get(id: string): ResearchTaskSnapshot | null {
    const task = this.tasks.get(id);
    return task ? publicSnapshot(task, true) : null;
  }

  list(limit = 10): ResearchTaskSnapshot[] {
    const cap = Math.max(1, Math.min(20, limit));
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, cap)
      .map((task) => publicSnapshot(task, false));
  }

  latestCompleted(): ResearchTaskSnapshot | null {
    const task = [...this.tasks.values()]
      .filter((item) => item.status === 'complete' && item.report)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return task ? publicSnapshot(task, true) : null;
  }

  save(id: string): ResearchDocument {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'complete' || !task.report) throw new ResearchTasksError('Only a completed report can be saved.', 409);
    if (task.savedReportId) {
      const saved = this.store.get(task.savedReportId);
      if (saved) return saved;
      task.savedReportId = null;
    }
    const { id: _taskId, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = task.report;
    try {
      const saved = this.store.save(content, this.now());
      task.savedReportId = saved.id;
      task.report = saved;
      task.updatedAt = this.now().toISOString();
      return saved;
    } catch (error) {
      if (error instanceof ResearchStoreError) throw new ResearchTasksError(error.message, 500);
      throw error;
    }
  }

  private async run(task: TaskRecord): Promise<void> {
    task.status = 'searching';
    task.progress = 'Preparing a focused search plan…';
    task.updatedAt = this.now().toISOString();
    try {
      const content = await this.execute(task.question, (status, message) => {
        task.status = status;
        task.progress = message;
        task.updatedAt = this.now().toISOString();
      });
      let report: ResearchDocument;
      if (task.updateReportId) {
        const originalTitle = this.store.get(task.updateReportId)?.title;
        const updated = this.store.replace(task.updateReportId, { ...content, title: originalTitle || content.title }, this.now());
        if (!updated) throw new Error('The saved report disappeared before its update completed.');
        report = updated;
        task.savedReportId = updated.id;
      } else {
        const now = this.now().toISOString();
        report = { ...content, id: task.id, createdAt: now, updatedAt: now };
      }
      task.report = report;
      task.title = report.title;
      task.status = 'complete';
      task.progress = task.updateReportId ? 'Saved report updated with fresh search evidence.' : 'Research complete. Save the report to keep it on this computer.';
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof ResearchTasksError ? error.message
        : error instanceof Error && error.name === 'ResearchWorkflowError' ? error.message
          : 'Research could not be completed. Check provider access and local storage, then try again.';
      task.progress = 'Research stopped; no new report was saved.';
    }
    task.updatedAt = this.now().toISOString();
  }

  private prune(): void {
    if (this.tasks.size < this.maxRetained) return;
    const finished = [...this.tasks.values()]
      .filter((task) => task.status === 'complete' || task.status === 'failed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.tasks.size >= this.maxRetained && finished.length) {
      const oldest = finished.shift()!;
      this.tasks.delete(oldest.id);
    }
  }
}
