/**
 * Deletions and inserts that are one edit (docs/device-sync.md, "Uploads",
 * "Pairs"). Etar moves an event to another calendar, and turns a series into
 * a single event, by deleting the row and inserting a copy. A deleted row
 * and a new row of the same run whose projections match apart from the
 * calendar (or the rule) upload as a patch of the existing object, so its
 * uid, participants and history stay; the new row then takes the old one's
 * identity. Across JMAP accounts nothing pairs: that move is a create in the
 * target account and a destroy in the source.
 */
import { Attendees, Events } from '../android-columns';
import type { CalendarContext, LocalEvent, LocalEventRow, OpGroup } from '../planner';
import type { Row } from '../types';
import type { CalendarEventWire } from '../wire';
import { exceptionRef, parseObjectRef } from '../common/ids';
import { applyPatch, type PatchObject } from '../common/patch';
import { EXCEPTION_CELLS, MASTER_CELLS, encodeBaseline, makeBaseline } from './columns';
import { durationTextSeconds } from './duration';
import { isExcluded, overridesOf } from './exceptions';
import { GroupBuilder, assertRow, deleteRow, updateRow } from './rows';
import { rruleParts } from './rrule';
import { sendsSchedulingMessages } from './scheduling';
import { put } from './upload';

/** What must be equal for two rows to be one event (the calendar and the rule aside). */
const PAIR_COLUMNS = [
  Events.TITLE,
  Events.DESCRIPTION,
  Events.EVENT_LOCATION,
  Events.STATUS,
  Events.AVAILABILITY,
  Events.ACCESS_LEVEL,
  Events.EVENT_COLOR,
  Events.DTSTART,
  Events.ALL_DAY,
];

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

function lengthMs(cells: Row): number | null {
  const dtstart = num(cells[Events.DTSTART]);
  const dtend = num(cells[Events.DTEND]);
  if (dtstart !== null && dtend !== null) return dtend - dtstart;
  const seconds = durationTextSeconds(cells[Events.DURATION]);
  return seconds === null ? null : seconds * 1000;
}

const attendeeSet = (row: LocalEventRow) =>
  row.attendees.map((a) => String(a.cells[Attendees.ATTENDEE_EMAIL] ?? '').toLowerCase()).sort().join(',');

export interface PairKind {
  /** The same event in another calendar. */
  move: boolean;
  /** A series turned into a single event. */
  unrecur: boolean;
}

/** How a deleted and a new row are one edit, or null. */
export function pairKind(deleted: LocalEvent, fresh: LocalEvent): PairKind | null {
  for (const c of PAIR_COLUMNS) {
    if (String(deleted.cells[c] ?? '') !== String(fresh.cells[c] ?? '')) return null;
  }
  const allDay = Number(fresh.cells[Events.ALL_DAY] ?? 0) === 1;
  if (!allDay && String(deleted.cells[Events.EVENT_TIMEZONE] ?? '') !== String(fresh.cells[Events.EVENT_TIMEZONE] ?? '')) return null;
  if (lengthMs(deleted.cells) !== lengthMs(fresh.cells)) return null;
  if (attendeeSet(deleted) !== attendeeSet(fresh)) return null;
  const move = deleted.calendarRowId !== fresh.calendarRowId;
  const deletedRule = rruleParts(deleted.cells[Events.RRULE]);
  const freshRule = rruleParts(fresh.cells[Events.RRULE]);
  const unrecur = !!deletedRule && !freshRule;
  if (!unrecur && String(deleted.cells[Events.RRULE] ?? '') !== String(fresh.cells[Events.RRULE] ?? '')) return null;
  return move || unrecur ? { move, unrecur } : null;
}

/** The patch a pair uploads: the calendar membership swapped, the rule and its overrides removed. */
export function pairPatch(
  deleted: LocalEvent,
  fresh: LocalEvent,
  kind: PairKind,
  ctx: CalendarContext,
): { patch: PatchObject; sendSchedulingMessages: boolean } | null {
  const shadow = deleted.shadow;
  if (!parseObjectRef(deleted.syncId) || !shadow) return null;
  const patch: PatchObject = {};
  if (kind.move) {
    const from = ctx.calendarIdOfRow(deleted.calendarRowId);
    const to = ctx.calendarIdOfRow(fresh.calendarRowId);
    if (!from || !to || from.jmapAccountId !== ctx.jmapAccountId || to.jmapAccountId !== ctx.jmapAccountId) return null;
    put(patch, ['calendarIds', from.calendarId], null);
    put(patch, ['calendarIds', to.calendarId], true);
  }
  if (kind.unrecur) {
    put(patch, ['recurrenceRule'], null);
    if (Object.keys(overridesOf(shadow)).length) put(patch, ['recurrenceOverrides'], null);
  }
  // A move alone tells nobody; a series ending its recurrence does.
  const scheduling = kind.unrecur && sendsSchedulingMessages(shadow, { kind: 'update', notifying: true, rsvp: false, addsAttendees: false }, ctx);
  return { patch, sendSchedulingMessages: scheduling };
}

/**
 * Applied once the pair's patch is accepted: the old row and its exception
 * rows go, the new row takes the identity (its copied exception rows the
 * overrides that still exist), and the shadow is the old one with the patch
 * applied until the next download brings the server's.
 */
export function pairOps(deleted: LocalEvent, fresh: LocalEvent, patch: PatchObject): OpGroup {
  const syncId = deleted.syncId!;
  const shadow: CalendarEventWire = applyPatch(deleted.shadow!, patch) ?? deleted.shadow!;
  const group = new GroupBuilder(syncId);
  assertRow(group, deleted, false, false);
  assertRow(group, fresh, false, true);
  for (const x of fresh.exceptions) assertRow(group, x, true, true);
  for (const x of deleted.exceptions) deleteRow(group, x.eventId);
  deleteRow(group, deleted.eventId);
  const children = (row: LocalEventRow) => ({ attendees: row.attendees.map((a) => a.cells), reminders: row.reminders.map((r) => r.cells) });
  const cells: Row = {};
  for (const c of MASTER_CELLS) cells[c] = fresh.cells[c] ?? null;
  updateRow(
    group,
    { ...fresh, shadow: null },
    {
      isException: false,
      cells,
      ...children(fresh),
      baseline: makeBaseline(fresh.cells, MASTER_CELLS, children(fresh).attendees, children(fresh).reminders),
      syncId,
      uid: typeof shadow.uid === 'string' ? shadow.uid : null,
      shadow,
      pending: null,
      clearDirty: true,
      hasParticipants: fresh.attendees.length > 0,
    },
  );
  const overrides = overridesOf(shadow);
  for (const x of fresh.exceptions) {
    const key = x.recurrenceId;
    const values: Row = { [Events.ORIGINAL_SYNC_ID]: syncId };
    if (key && overrides[key] && !isExcluded(overrides[key])) {
      Object.assign(values, {
        [Events._SYNC_ID]: exceptionRef(syncId, key),
        [Events.SYNC_DATA2]: key,
        [Events.SYNC_DATA4]: encodeBaseline(makeBaseline(x.cells, EXCEPTION_CELLS, children(x).attendees, children(x).reminders)),
        [Events.DIRTY]: 0,
      });
    }
    group.write({ op: 'update', table: 'events', id: x.eventId, values, expectCount: 1 });
  }
  return group.build();
}
