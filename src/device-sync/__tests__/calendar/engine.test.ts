// The calendar planner through the engine and the fake JMAP server: device
// edits reach the server as the user made them and the rows stay as the user
// left them, end to end. Mapping details are the planner's own tests.

import { describe, expect, it } from 'vitest';
import { Events, Reminders } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import { CALENDAR_AUTHORITY, createHarness, type Harness } from '../engine/harness';

function real(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const h = createHarness(options);
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

type Overrides = Record<string, Record<string, unknown>>;

describe('calendar device edits through the engine', () => {
  it('creates an event and an occurrence edit an app left without a status as confirmed ones', async () => {
    const h = real();
    const series = h.server.addEvent('a', {
      uid: 'weekly-uid',
      title: 'Weekly',
      start: '2026-10-05T08:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', count: 8 },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const master = h.events().find((e) => e[Events._SYNC_ID] === `a/${series}`)!;
    const rowId = Number(master[Events.CALENDAR_ID]);

    // Google Calendar leaves STATUS NULL on the events and exceptions it inserts.
    const created = h.device.user.insertEvent(rowId, {
      [Events.TITLE]: 'New from Google Calendar',
      [Events.DTSTART]: Date.UTC(2026, 9, 14, 13),
      [Events.DTEND]: Date.UTC(2026, 9, 14, 14),
      [Events.EVENT_TIMEZONE]: 'Europe/Berlin',
      [Events.STATUS]: null,
    });
    h.device.user.insertException(Number(master._id), Date.UTC(2026, 10, 9, 7), {
      [Events.TITLE]: 'Only Nov 9',
      [Events.DTSTART]: Date.UTC(2026, 10, 9, 7),
      [Events.DTEND]: Date.UTC(2026, 10, 9, 8),
      [Events.STATUS]: null,
    });
    expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 1, updated: 1 } } });

    const event = h.server.all('CalendarEvent', 'a').find((e) => e.title === 'New from Google Calendar')!;
    expect(event.status).toBeUndefined();
    const overrides = h.server.get('CalendarEvent', 'a', series)!.recurrenceOverrides as Overrides;
    expect(overrides['2026-11-09T08:00:00']).toMatchObject({ title: 'Only Nov 9' });
    expect(overrides['2026-11-09T08:00:00'].status).toBeUndefined();
    // The rows hold the default, confirmed, and are clean.
    expect(h.events().find((e) => Number(e._id) === created)).toMatchObject({ [Events.STATUS]: 1, [Events.DIRTY]: 0 });
    expect(h.events().filter((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${series}`).map((e) => [e[Events.STATUS], e[Events.DIRTY]])).toEqual([[1, 0]]);
  });

  it('keeps a reminder changed on one occurrence of a series on the calendar\'s default alerts', async () => {
    const h = real();
    h.server.serverUpdate('Calendar', 'a', h.calendar, {
      defaultAlertsWithTime: { d1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' } },
    });
    const id = h.server.addEvent('a', {
      uid: 'standup-uid',
      title: 'Standup',
      start: '2026-09-28T09:00:00',
      duration: 'PT15M',
      timeZone: 'Europe/Berlin',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', count: 5 },
      recurrenceOverrides: { '2026-09-29T09:00:00': { title: 'Standup (late)', start: '2026-09-29T10:00:00' } },
      useDefaultAlerts: true,
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const minutes = (eventId: unknown) => h.device.rows('reminders').filter((r) => r[Reminders.EVENT_ID] === Number(eventId)).map((r) => Number(r[Reminders.MINUTES]));
    const master = h.events().find((e) => e[Events._SYNC_ID] === `a/${id}`)!;
    const exception = () => h.events().find((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${id}`)!;
    expect([minutes(master._id), minutes(exception()._id)]).toEqual([[15], [15]]);

    h.device.user.setReminders(Number(exception()._id), [{ minutes: 60 }]);
    expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });

    expect(exception()[Events.DIRTY]).toBe(0);
    expect([minutes(master._id), minutes(exception()._id)]).toEqual([[15], [60]]);
    const event = h.server.get('CalendarEvent', 'a', id)!;
    expect(event.useDefaultAlerts).toBe(true);
    expect((event.recurrenceOverrides as Overrides)['2026-09-29T09:00:00']).toMatchObject({ useDefaultAlerts: false });
    // Its echo writes nothing.
    const before = h.batches.log.length;
    await h.run(CALENDAR_AUTHORITY);
    expect(h.batches.log.slice(before).filter((ops) => ops.some((op) => op.op !== 'syncState' && op.op !== 'assert'))).toEqual([]);
  });

  it('keeps a description and location cleared on one occurrence cleared', async () => {
    const h = real();
    const id = h.server.addEvent('a', {
      uid: 'standup-uid',
      title: 'Standup',
      description: 'Daily agenda',
      start: '2026-09-28T09:00:00',
      duration: 'PT15M',
      timeZone: 'Europe/Berlin',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', count: 5 },
      locations: { locA: { '@type': 'Location', name: 'Room 1' } },
      recurrenceOverrides: {
        '2026-09-29T09:00:00': { title: 'Standup', description: 'Special agenda', locations: { locB: { '@type': 'Location', name: 'Room 2' } } },
      },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const exception = () => h.events().find((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${id}`)!;
    expect(exception()).toMatchObject({ [Events.DESCRIPTION]: 'Special agenda', [Events.EVENT_LOCATION]: 'Room 2' });

    h.device.user.updateEvent(Number(exception()._id), { [Events.DESCRIPTION]: null, [Events.EVENT_LOCATION]: null });
    expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });

    expect(exception()).toMatchObject({ [Events.DESCRIPTION]: null, [Events.EVENT_LOCATION]: null, [Events.DIRTY]: 0 });
    const overrides = h.server.get('CalendarEvent', 'a', id)!.recurrenceOverrides as Overrides;
    expect(overrides['2026-09-29T09:00:00']).toMatchObject({ description: '', locations: { locB: { name: '' } } });
  });
});
