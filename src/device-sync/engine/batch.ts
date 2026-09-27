/**
 * Packs item op groups into provider batches and applies them
 * (docs/device-sync.md, "SyncState", "Native module API", "Failure matrix"):
 *
 * - a group is never split; `refs` are rebased to the batch and the group's
 *   first op is its yield point, so the provider may commit between groups
 *   but never inside one;
 * - at most `maxOps` ops and about `maxBytes` of JSON per batch; groups that
 *   carry photo bytes travel alone (Binder budget);
 * - the SyncState op, when there is one, is the last op of the last batch
 *   and never a yield point: the stored state can't get ahead of its rows.
 *
 * A failed batch may have been committed up to a yield point the provider
 * took, so its groups are retried one by one (their asserts make a retry of
 * a committed group fail harmlessly); a group that fails an assert is
 * re-read and re-planned up to `maxReplans` times, then given up. `tooLarge`
 * splits the batch; `permission` ends the run.
 */
import type { OpGroup } from '../planner';
import type { BatchFailure, OpResult, ProviderOp, ProviderPort } from '../types';
import { RunAbort } from './errors';
import { hasWrites } from './provider';
import type { Tail } from './sync-state';

export interface Work {
  group: OpGroup;
  /** The group applied; `results` are its ops' results (new row ids for inserts). */
  applied?(results: OpResult[]): void | Promise<void>;
  /** After an assert failure: read the item again and plan it again; null when nothing is left to write. */
  replan?(): Promise<Work | null>;
  /** Given up: the item's rows stay as they are. */
  failed?(reason: BatchFailure, message: string): void | Promise<void>;
}

export interface BatchWriterOptions {
  maxOps: number;
  maxBytes: number;
  maxReplans: number;
}

function sizeOf(ops: readonly ProviderOp[]): number {
  return JSON.stringify(ops).length;
}

function carriesBlob(ops: readonly ProviderOp[]): boolean {
  return ops.some(
    (op) =>
      (op.op === 'insert' || op.op === 'update') &&
      Object.values(op.values).some((v) => v !== null && typeof v === 'object'),
  );
}

/** A group's ops at `offset` in a batch: refs rebased, the first op a yield point, no other. */
function placeGroup(ops: readonly ProviderOp[], offset: number): ProviderOp[] {
  return ops.map((op, i) => {
    const copy = { ...op } as ProviderOp & { yieldAllowed?: boolean };
    if (copy.op === 'insert' && copy.refs) {
      const refs: Record<string, number> = {};
      for (const [column, index] of Object.entries(copy.refs)) refs[column] = index + offset;
      copy.refs = refs;
    }
    if (i === 0) copy.yieldAllowed = true;
    else delete copy.yieldAllowed;
    return copy;
  });
}

export function buildBatch(groups: readonly OpGroup[], tailOp?: ProviderOp): ProviderOp[] {
  const out: ProviderOp[] = [];
  for (const group of groups) out.push(...placeGroup(group.ops, out.length));
  if (tailOp) {
    const { yieldAllowed: _never, ...last } = tailOp as ProviderOp & { yieldAllowed?: boolean };
    out.push(last as ProviderOp);
  }
  return out;
}

/** Prepends ops to a group (e.g. an engine-side assert), shifting the group's refs. */
export function prependOps(group: OpGroup, ops: ProviderOp[]): OpGroup {
  return { ref: group.ref, ops: [...ops, ...placeGroup(group.ops, ops.length).map(stripYield)] };
}

/** One group running `first` then `second` atomically. */
export function concatGroups(ref: string, first: OpGroup, second: OpGroup): OpGroup {
  return {
    ref,
    ops: [...first.ops.map(stripYield), ...placeGroup(second.ops, first.ops.length).map(stripYield)],
  };
}

function stripYield(op: ProviderOp): ProviderOp {
  const { yieldAllowed: _y, ...rest } = op as ProviderOp & { yieldAllowed?: boolean };
  return rest as ProviderOp;
}

export class BatchWriter {
  /** Batches sent, for tests and logs. */
  batchesSent = 0;

  constructor(
    private readonly port: ProviderPort,
    private readonly options: BatchWriterOptions,
  ) {}

  /**
   * Applies the works in order; `tail` (the SyncState op) goes last, after
   * every group of `works` was applied or given up.
   */
  async write(works: readonly Work[], tail?: Tail): Promise<void> {
    const todo = works.filter((w) => hasWrites(w.group.ops));
    const batches = this.pack(todo);
    if (batches.length === 0) {
      if (tail) await this.applyTail(tail);
      return;
    }
    for (let i = 0; i < batches.length; i++) {
      const last = i === batches.length - 1;
      const batch = batches[i];
      // A photo batch is already at the Binder budget: its state op goes alone.
      const tailHere = last && tail && !(batch.length === 1 && carriesBlob(batch[0].group.ops)) ? tail : undefined;
      await this.applyBatch(batch, tailHere);
      if (last && tail && !tailHere) await this.applyTail(tail);
    }
  }

  private pack(works: readonly Work[]): Work[][] {
    const batches: Work[][] = [];
    let current: Work[] = [];
    let ops = 0;
    let bytes = 0;
    const flush = () => {
      if (current.length) batches.push(current);
      current = [];
      ops = 0;
      bytes = 0;
    };
    for (const work of works) {
      if (carriesBlob(work.group.ops)) {
        flush();
        batches.push([work]);
        continue;
      }
      const n = work.group.ops.length;
      const b = sizeOf(work.group.ops);
      if (current.length && (ops + n > this.options.maxOps || bytes + b > this.options.maxBytes)) flush();
      current.push(work);
      ops += n;
      bytes += b;
    }
    flush();
    return batches;
  }

  private async send(ops: ProviderOp[]) {
    this.batchesSent++;
    const result = await this.port.applyBatch(ops);
    if (!result.ok) {
      if (result.reason === 'permission') throw new RunAbort('permission', result.message);
      // The native side refused an op outside our account: an engine bug, never retried.
      if (result.reason === 'scope') throw new Error(`Provider refused an op: ${result.message}`);
    }
    return result;
  }

  private async applyBatch(works: Work[], tail?: Tail): Promise<void> {
    const tailOp = tail?.op();
    const result = await this.send(buildBatch(works.map((w) => w.group), tailOp));
    if (result.ok) {
      let offset = 0;
      for (const work of works) {
        const n = work.group.ops.length;
        await work.applied?.(result.results.slice(offset, offset + n));
        offset += n;
      }
      tail?.applied();
      return;
    }
    if (result.reason === 'tooLarge' && works.length > 1) {
      const middle = Math.ceil(works.length / 2);
      await this.applyBatch(works.slice(0, middle));
      await this.applyBatch(works.slice(middle), tail);
      return;
    }
    if (works.length === 1 && !tail) {
      await this.retryAlone(works[0], result.reason, result.message);
      return;
    }
    for (const work of works) await this.applyAlone(work, 0);
    if (tail) await this.applyTail(tail);
  }

  private async applyAlone(work: Work, attempt: number): Promise<void> {
    if (!hasWrites(work.group.ops)) return;
    const result = await this.send(buildBatch([work.group]));
    if (result.ok) {
      await work.applied?.(result.results);
      return;
    }
    await this.retryAlone(work, result.reason, result.message, attempt);
  }

  private async retryAlone(work: Work, reason: BatchFailure, message: string, attempt = 0): Promise<void> {
    if (reason === 'assert' && work.replan && attempt < this.options.maxReplans) {
      const next = await work.replan();
      if (next) await this.applyAlone(next, attempt + 1);
      return;
    }
    await work.failed?.(reason, message);
  }

  private async applyTail(tail: Tail): Promise<void> {
    const result = await this.send([...buildBatch([], tail.op())]);
    if (!result.ok) throw new Error(`Could not store the sync state: ${result.reason} ${result.message}`);
    tail.applied();
  }
}
