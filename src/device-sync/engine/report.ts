/**
 * The run report (`RunReport`, docs/device-sync.md "Headless payload, report
 * and SyncResult"). Counts are objects actually written or sent, so a run
 * that repeated a page without writing anything is no progress to
 * SyncManager.
 */
import type { Authority, ItemError, RunOutcome, RunReport, RunStats, RunStatus } from '../types';

export function emptyStats(): RunStats {
  return {
    downloaded: { created: 0, updated: 0, deleted: 0 },
    uploaded: { created: 0, updated: 0, deleted: 0 },
    entries: 0,
    skipped: 0,
  };
}

export class ReportBuilder {
  readonly stats = emptyStats();
  conflicts = 0;
  private readonly errors: ItemError[] = [];
  private errorCount = 0;
  private readonly notes = new Set<string>();
  tooManyDeletions?: { count: number; threshold: number };

  constructor(
    readonly runId: string,
    readonly authority: Authority,
    readonly startedAt: number,
    private readonly maxItemErrors = 50,
  ) {}

  itemError(error: ItemError): void {
    this.errorCount++;
    // One entry per item and side: a retried item is reported once, with its latest error.
    const existing = this.errors.findIndex((e) => e.ref === error.ref && e.side === error.side);
    if (existing >= 0) {
      this.errors[existing] = error;
      this.errorCount--;
      return;
    }
    if (this.errors.length < this.maxItemErrors) this.errors.push(error);
  }

  /** A note for the report's message ("invitations not sent", …). */
  note(text: string): void {
    this.notes.add(text);
  }

  get itemErrorCount(): number {
    return this.errorCount;
  }

  build(
    outcome: RunOutcome,
    now: number,
    extra: { message?: string; delayUntil?: number; moreRecordsToGet?: boolean; noProgress?: boolean } = {},
  ): RunReport {
    const stats: RunStats = JSON.parse(JSON.stringify(this.stats));
    if (extra.noProgress) {
      stats.downloaded = { created: 0, updated: 0, deleted: 0 };
      stats.uploaded = { created: 0, updated: 0, deleted: 0 };
    }
    const message = [extra.message, ...this.notes].filter(Boolean).join('; ');
    const report: RunReport = {
      v: 1,
      runId: this.runId,
      authority: this.authority,
      outcome,
      startedAt: this.startedAt,
      durationMs: Math.max(0, now - this.startedAt),
      stats,
      conflicts: this.conflicts,
      itemErrors: this.errors.slice(),
    };
    if (message) report.message = message;
    if (outcome === 'tooManyDeletions' && this.tooManyDeletions) report.tooManyDeletions = this.tooManyDeletions;
    if (extra.delayUntil !== undefined) report.delayUntil = extra.delayUntil;
    if (extra.moreRecordsToGet) report.moreRecordsToGet = true;
    return report;
  }
}

export function statusOf(report: RunReport, itemErrorCount = report.itemErrors.length): RunStatus {
  const status: RunStatus = {
    at: report.startedAt + report.durationMs,
    outcome: report.outcome,
    durationMs: report.durationMs,
    conflicts: report.conflicts,
    itemErrors: itemErrorCount,
    stats: report.stats,
  };
  if (report.message) status.message = report.message;
  return status;
}
