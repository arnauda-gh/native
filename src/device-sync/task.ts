/**
 * Entry of the BulwarkDeviceSync headless task, which the contacts and
 * calendar sync adapters start for every sync (index.ts registers it). See
 * docs/device-sync.md.
 *
 * The run must always end with `finishRun`, called before the task's promise
 * settles: JS timers stop once the task is over, and a sync adapter waiting
 * for a report that never comes holds its sync until the deadline.
 *
 * The sync engine is not wired in yet, so a run only reports that device
 * sync is off; nothing in the app can turn it on at this point.
 */
import { NativeModules } from 'react-native';
import type { DeviceSyncNativeModule, RunPayload, RunReport } from './types';

export async function runDeviceSyncTask(payload: RunPayload): Promise<void> {
  const native = NativeModules.BulwarkDeviceSync as DeviceSyncNativeModule | undefined;
  if (!native || !payload?.runId) return;
  const report: RunReport = {
    v: 1,
    runId: payload.runId,
    authority: payload.authority,
    outcome: 'disabled',
    message: 'Device sync is not available in this build',
    startedAt: Date.now(),
    durationMs: 0,
    stats: {
      downloaded: { created: 0, updated: 0, deleted: 0 },
      uploaded: { created: 0, updated: 0, deleted: 0 },
      entries: 0,
      skipped: 0,
    },
    conflicts: 0,
    itemErrors: [],
  };
  try {
    await native.finishRun(payload.runId, JSON.stringify(report));
  } catch {
    // The adapter ends the run on its own when the task finishes.
  }
}
