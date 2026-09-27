// Big meetings (many attendees on many overrides): a write into such an event
// has to fit one provider transaction (Binder: about 1 MB; a Parcel carries
// the JSON as UTF-16, estimated at 2 bytes per character plus ~300 per op).
import { describe, expect, it } from 'vitest';
import { Attendees, Events } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import type { OpGroup } from '../../planner';
import type { CalendarEventWire } from '../../wire';
import { Harness, ME, serverApply } from './harness';

const TRANSACTION = 1_000_000;
const estimate = (group: OpGroup) => 2 * JSON.stringify(group.ops).length + 300 * group.ops.length;

/** A daily meeting with `attendees` guests whose `overrides` occurrences each carry the whole participants map. */
function meeting(attendees: number, overrides: number): CalendarEventWire {
  const participants: Record<string, unknown> = {
    me: { '@type': 'Participant', calendarAddress: `mailto:${ME}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
  };
  for (let i = 0; i < attendees; i++) {
    participants[`p${i}`] = { '@type': 'Participant', calendarAddress: `mailto:person${i}@example.com`, name: `Person ${i}`, roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true };
  }
  const recurrenceOverrides: Record<string, unknown> = {};
  for (let i = 0; i < overrides; i++) {
    const day = new Date(Date.UTC(2026, 9, 6) + i * 86_400_000).toISOString().slice(0, 10);
    recurrenceOverrides[`${day}T09:00:00`] = { title: `Standup #${i}`, participants };
  }
  return {
    id: 'big',
    '@type': 'Event',
    uid: 'big@example.org',
    calendarIds: { b: true },
    title: 'Standup',
    description: 'Daily standup',
    start: '2026-10-05T09:00:00',
    timeZone: 'Europe/Berlin',
    duration: 'PT15M',
    recurrenceRule: { frequency: 'daily', count: 300 },
    organizerCalendarAddress: `mailto:${ME}`,
    participants,
    recurrenceOverrides,
  } as unknown as CalendarEventWire;
}

async function synced(event: CalendarEventWire) {
  const h = await new Harness().setup();
  await h.download(event);
  return { h, id: Number(h.masterRow(event.id)._id) };
}

describe('calendar planner: big meetings', () => {
  it('fits the writes after an edit of a big meeting into one transaction', async () => {
    const event = meeting(25, 52);
    const { h, id } = await synced(event);
    // Only the series row is edited; its 52 occurrences with 26 attendees each stay clean.
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Daily standup' });
    const local = (await h.local('big'))!;

    const plan = calendarPlanner.planUpload(local, h.ctx);
    if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(plan.kind);
    const server = serverApply(event, plan.actions[0].patch);
    const accepted = calendarPlanner.planAccepted(local, server, h.ctx);
    expect(estimate(accepted.ops)).toBeLessThan(TRANSACTION);
    expect(estimate(accepted.keepDirtyOps)).toBeLessThan(TRANSACTION);

    // A download into the edited event (the server changed one occurrence meanwhile).
    const remote = { ...event, recurrenceOverrides: { ...event.recurrenceOverrides, '2026-10-09T09:00:00': { title: 'Moved to Friday' } } } as CalendarEventWire;
    expect(estimate(calendarPlanner.planDownload(remote, local, h.ctx).ops)).toBeLessThan(TRANSACTION);

    // A save that changed nothing mapped is cleared the same way.
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Standup' });
    const clean = calendarPlanner.planUpload((await h.local('big'))!, h.ctx);
    expect(clean.kind).toBe('clean');
    if (clean.kind === 'clean') expect(estimate(clean.ops)).toBeLessThan(TRANSACTION);
  });

  it('still fails a write when an app changed a clean occurrence\'s attendees meanwhile', async () => {
    const event = meeting(3, 4);
    const { h, id } = await synced(event);
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Daily standup' });
    const local = (await h.local('big'))!;
    const x = local.exceptions[0];
    const plan = calendarPlanner.planUpload(local, h.ctx);
    if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(plan.kind);
    const accepted = calendarPlanner.planAccepted(local, serverApply(event, plan.actions[0].patch), h.ctx);
    // The occurrence's attendees are not asserted one by one: CalendarProvider marks the event DIRTY on any app write to them.
    h.fake.beforeNextBatch(() => h.fake.user.setAttendeeStatus(x.eventId, 'person1@example.com', 1));
    expect(await h.tryApply(accepted.ops)).toMatchObject({ ok: false, reason: 'assert' });
    expect(h.fake.rows('attendees', `${Attendees.EVENT_ID} = ? AND ${Attendees.ATTENDEE_EMAIL} = ?`, [x.eventId, 'person1@example.com'])[0][Attendees.ATTENDEE_STATUS]).toBe(1);
  });
});
