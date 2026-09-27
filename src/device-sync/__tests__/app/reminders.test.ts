import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ available: true }));

vi.mock('../../native', () => ({
  isDeviceSyncAvailable: () => h.available,
}));

import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY } from '../../types';
import type { CalendarEvent } from '../../../api/types';
import { useDeviceSyncStore, waitForDeviceSyncHydration } from '../../../stores/device-sync-store';
import { onDeviceRemindersChange, remindedOnDevice } from '../../app/reminders';

const ALICE = 'alice@mail.example.org';

function event(id: string, calendarIds: Record<string, boolean>): CalendarEvent {
  return { id, calendarIds, title: id, start: '2026-09-24T12:00:00', duration: 'PT1H' } as CalendarEvent;
}

function calendarSync(extra: Record<string, unknown> = {}): void {
  useDeviceSyncStore.setState({
    accounts: {
      [ALICE]: {
        contactsSelection: {},
        calendarSelection: { 'c/work': false, 'team/shared-on': true },
        reminderOwner: 'device',
        intervalSeconds: {},
        lastRun: {},
        androidAccountName: 'alice',
        enabled: { [CALENDAR_AUTHORITY]: true },
        ...extra,
      },
    },
  });
}

beforeEach(async () => {
  await waitForDeviceSyncHydration();
  h.available = true;
  calendarSync();
});

describe('remindedOnDevice', () => {
  it("picks the events of the account's synced calendars", () => {
    const onDevice = remindedOnDevice(ALICE, 'c')!;
    // Own calendars sync unless turned off.
    expect(onDevice(event('a', { personal: true }))).toBe(true);
    expect(onDevice(event('b', { work: true }))).toBe(false);
    expect(onDevice(event('c', { work: true, personal: true }))).toBe(true);
    // Shared calendars: namespaced ids in calendarIds, raw ones in originalCalendarIds.
    expect(onDevice({
      ...event('d', { 'team:shared-on': true }),
      accountId: 'team',
      originalCalendarIds: { 'shared-on': true },
    })).toBe(true);
    expect(onDevice({
      ...event('e', { 'team:other': true }),
      accountId: 'team',
      originalCalendarIds: { other: true },
    })).toBe(false);
  });

  it('leaves everything to Bulwark when Bulwark reminds, or calendars do not sync', () => {
    calendarSync({ reminderOwner: 'bulwark' });
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();
    calendarSync({ enabled: { [CONTACTS_AUTHORITY]: true } });
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();
    calendarSync({ removedInAndroidSettings: true });
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();
    expect(remindedOnDevice('someone@else', 'c')).toBeNull();
    expect(remindedOnDevice(null, 'c')).toBeNull();
  });

  it('counts the calendar app as the owner until the user chose', () => {
    calendarSync({ reminderOwner: null });
    expect(remindedOnDevice(ALICE, 'c')?.(event('a', { personal: true }))).toBe(true);
  });

  it('does nothing where device sync is not available', () => {
    h.available = false;
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();
  });
});

describe('onDeviceRemindersChange', () => {
  it('fires for the owner and the calendar selection, not for sync bookkeeping', () => {
    const listener = vi.fn();
    const off = onDeviceRemindersChange(listener);
    const store = useDeviceSyncStore.getState();

    store.recordKnownState(ALICE, 'c', 'CalendarEvent', 's1');
    store.setIntervalSeconds(ALICE, CALENDAR_AUTHORITY, 900);
    expect(listener).not.toHaveBeenCalled();

    store.setReminderOwner(ALICE, 'bulwark');
    expect(listener).toHaveBeenCalledTimes(1);
    store.setReminderOwner(ALICE, 'device');
    store.setCollectionSelected(ALICE, CALENDAR_AUTHORITY, 'c/work', true);
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    store.setEnabled(ALICE, CALENDAR_AUTHORITY, false);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
