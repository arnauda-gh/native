// The calendar planner through the engine and the fake JMAP server: device
// edits reach the server as the user made them and the rows stay as the user
// left them, end to end. Mapping details are the planner's own tests.

import { describe, expect, it } from 'vitest';
import { Events } from '../../android-columns';
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
