/**
 * Who reminds the user of synced events (docs/device-sync.md, "Reminder
 * owner"). When an account's calendars sync to the device and the calendar
 * app owns the reminders, the device fires them from its Reminders rows, so
 * Bulwark's own scheduler skips the events of those calendars. Tasks are not
 * synced and keep Bulwark's reminders.
 */
import type { CalendarEvent } from '../../api/types';
import {
  isCollectionSelected,
  selectionFor,
  syncOnInApp,
  useDeviceSyncStore,
  type AccountDeviceSync,
} from '../../stores/device-sync-store';
import { collectionKey } from '../common/ids';
import { CALENDAR_AUTHORITY } from '../types';
import { deviceSyncAvailable } from './available';

/** Whether the device's calendar app fires the reminders of an account's synced events. */
function deviceOwnsReminders(entry: AccountDeviceSync | undefined): entry is AccountDeviceSync {
  // Unasked means the calendar app, as the engine writes Reminders rows then.
  return !!entry && syncOnInApp(entry, CALENDAR_AUTHORITY) && (entry.reminderOwner ?? 'device') === 'device';
}

/**
 * A test for the events whose reminders the device's calendar app fires for
 * this app account, so Bulwark schedules none; null when there are none.
 * `primaryJmapAccountId`: the JMAP account the app's calendar store loads
 * events from when they carry no `accountId` (the user's own).
 */
export function remindedOnDevice(
  registryId: string | null | undefined,
  primaryJmapAccountId: string | null | undefined,
): ((event: CalendarEvent) => boolean) | null {
  if (!registryId || !deviceSyncAvailable()) return null;
  const entry = useDeviceSyncStore.getState().accounts[registryId];
  if (!deviceOwnsReminders(entry)) return null;
  const selection = selectionFor(entry, CALENDAR_AUTHORITY);
  const personal = entry.primaryJmapAccounts?.[CALENDAR_AUTHORITY] ?? primaryJmapAccountId ?? null;
  return (event) => {
    // Events of shared calendars carry their account and a namespaced copy
    // of calendarIds; the raw ids are in originalCalendarIds.
    const jmapAccountId = event.accountId ?? primaryJmapAccountId;
    if (!jmapAccountId) return false;
    const calendarIds = event.originalCalendarIds ?? event.calendarIds ?? {};
    return Object.entries(calendarIds).some(([calendarId, member]) =>
      !!member && isCollectionSelected(selection, CALENDAR_AUTHORITY, {
        key: collectionKey(jmapAccountId, calendarId),
        isPersonal: jmapAccountId === personal,
      }));
  };
}

// What decides which events the device reminds of, as one comparable string.
function reminderSignature(accounts: Record<string, AccountDeviceSync>): string {
  const parts: unknown[] = [];
  for (const registryId of Object.keys(accounts).sort()) {
    const entry = accounts[registryId];
    if (!deviceOwnsReminders(entry)) continue;
    parts.push([registryId, entry.calendarSelection, entry.primaryJmapAccounts?.[CALENDAR_AUTHORITY] ?? null]);
  }
  return JSON.stringify(parts);
}

/**
 * Calls `listener` whenever the set of events the device reminds of may have
 * changed (reminder owner, calendar sync on or off, the calendar selection).
 * Returns the unsubscribe.
 */
export function onDeviceRemindersChange(listener: () => void): () => void {
  let last = reminderSignature(useDeviceSyncStore.getState().accounts);
  return useDeviceSyncStore.subscribe((state) => {
    const next = reminderSignature(state.accounts);
    if (next === last) return;
    last = next;
    listener();
  });
}
