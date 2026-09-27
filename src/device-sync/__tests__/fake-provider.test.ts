import { describe, expect, it } from 'vitest';
import {
  Attendees,
  Calendars,
  Data,
  Events,
  MimeType,
  RawContacts,
  StructuredName,
  StructuredPostal,
} from '../android-columns';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY, type ProviderOp } from '../types';
import { FakeDeviceProviders, aospDurationValid, aospRruleValid } from './fakes/fake-provider';
import { compileWhere } from './fakes/fake-sql';

const ME = 'usera@example.org';
const OTHER = 'someone@example.org';

async function contactWithEmail(fake: FakeDeviceProviders, account = ME) {
  const port = fake.port(account, CONTACTS_AUTHORITY);
  const res = await port.applyBatch([
    { op: 'insert', table: 'raw_contacts', values: { [RawContacts.SOURCE_ID]: 'c/e1' } },
    {
      op: 'insert',
      table: 'data',
      values: { [Data.MIMETYPE]: MimeType.EMAIL, [Data.DATA1]: 'a@example.org', [Data.DATA_SYNC1]: 'emails:e1' },
      refs: { [Data.RAW_CONTACT_ID]: 0 },
    },
  ]);
  if (!res.ok) throw new Error(res.message);
  return { port, rawId: res.results[0].id!, dataId: res.results[1].id! };
}

describe('fake-sql', () => {
  const row = (r: Record<string, string | number | null>) => (c: string) => r[c] ?? null;

  it('evaluates the documented subset with SQL precedence and NULL rules', () => {
    const where = compileWhere('dirty = 1 OR deleted = 1 AND sourceid IS NOT NULL', []);
    expect(where(row({ dirty: 0, deleted: 1, sourceid: null }))).toBe(false);
    expect(where(row({ dirty: 1, deleted: 0, sourceid: null }))).toBe(true);
    expect(compileWhere('x IN (?, ?, 3)', ['1', 2])(row({ x: 3 }))).toBe(true);
    expect(compileWhere('x NOT IN (?)', ['1'])(row({ x: null }))).toBe(false);
    expect(compileWhere("mimetype LIKE '%/email%'")(row({ mimetype: 'vnd.android.cursor.item/email_v2' }))).toBe(true);
    expect(compileWhere('version = ?', ['2'])(row({ version: 2 }))).toBe(true);
    expect(compileWhere('NOT (a = 1)')(row({ a: null }))).toBe(true);
    expect(() => compileWhere('a = ?', [])).toThrow(/placeholders/);
  });
});

describe('FakeDeviceProviders: contacts', () => {
  it('scopes every read and write to the port account', async () => {
    const fake = new FakeDeviceProviders();
    const mine = await contactWithEmail(fake, ME);
    const theirs = await contactWithEmail(fake, OTHER);
    const rows = await mine.port.query({ table: 'raw_contacts', columns: [RawContacts._ID] });
    expect(rows.rows).toEqual([[mine.rawId]]);
    const data = await mine.port.query({ table: 'data', columns: [Data._ID] });
    expect(data.rows).toEqual([[mine.dataId]]);
    const denied = await mine.port.applyBatch([{ op: 'update', table: 'raw_contacts', id: theirs.rawId, values: { [RawContacts.SYNC1]: 'x' } }]);
    expect(denied).toMatchObject({ ok: false, reason: 'scope' });
    const orphan = await mine.port.applyBatch([
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: theirs.rawId, [Data.MIMETYPE]: MimeType.NOTE } },
    ]);
    expect(orphan).toMatchObject({ ok: false, reason: 'scope' });
    await expect(mine.port.query({ table: 'events', columns: ['_id'] })).rejects.toThrow(/scope/);
  });

  it('never sets DIRTY for the sync adapter but does for app edits, and only apps soft-delete', async () => {
    const fake = new FakeDeviceProviders();
    const { rawId, dataId } = await contactWithEmail(fake);
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(0);
    fake.user.updateData(dataId, { [Data.DATA1]: 'b@example.org' });
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(1);
    expect(fake.row('data', dataId)![Data.DATA_SYNC1]).toBe('emails:e1');
    fake.user.deleteContact(rawId);
    expect(fake.row('raw_contacts', rawId)).toMatchObject({ [RawContacts.DELETED]: 1, [RawContacts.DIRTY]: 1 });
    const port = fake.port(ME, CONTACTS_AUTHORITY);
    await port.applyBatch([{ op: 'delete', table: 'raw_contacts', id: rawId }]);
    expect(fake.row('raw_contacts', rawId)).toBeUndefined();
    expect(fake.row('data', dataId)).toBeUndefined();
  });

  it('bumps VERSION for data writes by anyone but not for DIRTY, SOURCE_ID or SYNC columns', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId, dataId } = await contactWithEmail(fake);
    const version = () => fake.row('raw_contacts', rawId)![RawContacts.VERSION];
    expect(version()).toBe(2); // one bump for the batch's data inserts
    await port.applyBatch([
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.DIRTY]: 0, [RawContacts.SYNC2]: '{}', [RawContacts.SOURCE_ID]: 'c/e2' } },
    ]);
    expect(version()).toBe(2);
    await port.applyBatch([{ op: 'update', table: 'data', id: dataId, values: { [Data.DATA_SYNC3]: '{}' } }]);
    expect(version()).toBe(3);
    fake.user.star(rawId);
    expect(version()).toBe(3);
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(1);
  });

  it('applies a batch atomically and fails it on a stale VERSION assert', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId, dataId } = await contactWithEmail(fake);
    fake.user.updateData(dataId, { [Data.DATA1]: 'edited@example.org' });
    const clear: ProviderOp[] = [
      { op: 'assert', table: 'raw_contacts', id: rawId, values: { [RawContacts.VERSION]: 2 } },
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.DIRTY]: 0 } },
    ];
    expect(await port.applyBatch(clear)).toMatchObject({ ok: false, reason: 'assert' });
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(1);
    const current = fake.row('raw_contacts', rawId)![RawContacts.VERSION] as number;
    const ok = await port.applyBatch([
      { op: 'assert', table: 'raw_contacts', id: rawId, values: { [RawContacts.VERSION]: current } },
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.DIRTY]: 0 } },
      { op: 'syncState', value: '{"v":1}' },
    ]);
    expect(ok.ok).toBe(true);
    expect(fake.readSyncState(ME, CONTACTS_AUTHORITY)).toBe('{"v":1}');
  });

  it('runs a hook right before the next batch, for concurrent-edit tests', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId, dataId } = await contactWithEmail(fake);
    const v = fake.row('raw_contacts', rawId)![RawContacts.VERSION] as number;
    fake.beforeNextBatch(() => fake.user.updateData(dataId, { [Data.DATA1]: 'late@example.org' }));
    const res = await port.applyBatch([
      { op: 'assert', table: 'raw_contacts', id: rawId, values: { [RawContacts.VERSION]: v } },
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.DIRTY]: 0 } },
    ]);
    expect(res.ok).toBe(false);
  });

  it('refuses 500 contacts ops without a yield point and oversized batches', async () => {
    const fake = new FakeDeviceProviders({ maxBatchBytes: 50_000 });
    const port = fake.port(ME, CONTACTS_AUTHORITY);
    const ops: ProviderOp[] = Array.from({ length: 500 }, () => ({ op: 'insert', table: 'raw_contacts', values: {} }) as ProviderOp);
    expect(await port.applyBatch(ops)).toMatchObject({ ok: false, reason: 'provider' });
    ops[250] = { ...ops[250], yieldAllowed: true };
    expect((await port.applyBatch(ops)).ok).toBe(true);
    const big = await port.applyBatch([{ op: 'insert', table: 'raw_contacts', values: { [RawContacts.SYNC2]: 'x'.repeat(60_000) } }]);
    expect(big).toMatchObject({ ok: false, reason: 'tooLarge' });
  });

  it('normalises names and addresses like ContactsProvider', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, [StructuredName.DISPLAY_NAME]: 'Ada Lovelace' } },
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.STRUCTURED_POSTAL, [StructuredPostal.CITY]: 'London', [StructuredPostal.COUNTRY]: 'UK' } },
    ]);
    if (!res.ok) throw new Error(res.message);
    expect(fake.row('data', res.results[0].id!)).toMatchObject({ [StructuredName.GIVEN_NAME]: 'Ada', [StructuredName.FAMILY_NAME]: 'Lovelace' });
    expect(fake.row('data', res.results[1].id!)![StructuredPostal.FORMATTED_ADDRESS]).toBe('London, UK');
  });

  it('stores a photo written as a blob and serves it to readPhoto', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.PHOTO, [Data.DATA15]: { b64: 'AAAA' } } },
    ]);
    expect(res.ok).toBe(true);
    const photo = await port.readPhoto(rawId, 512);
    expect(photo?.jpegBase64).toBe('AAAA');
    expect(photo?.fileId).toEqual(expect.any(Number));
    const rows = await port.query({ table: 'data', columns: [Data.DATA14, Data.DATA15], where: `${Data.MIMETYPE} = ?`, args: [MimeType.PHOTO] });
    expect(rows.rows[0]).toEqual([photo!.fileId, null]);
  });

  it('models Fossify saves: rows re-inserted without DATA_SYNC', async () => {
    const fake = new FakeDeviceProviders();
    const { rawId, dataId } = await contactWithEmail(fake);
    fake.user.fossifySave(rawId, null, [{ [Data.MIMETYPE]: MimeType.EMAIL, [Data.DATA1]: 'a@example.org' }]);
    expect(fake.row('data', dataId)).toBeUndefined();
    const emails = fake.rows('data', `${Data.RAW_CONTACT_ID} = ?`, [rawId]);
    expect(emails).toHaveLength(1);
    expect(emails[0][Data.DATA_SYNC1]).toBeNull();
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(1);
  });
});

describe('FakeDeviceProviders: calendar', () => {
  async function calendar(fake: FakeDeviceProviders) {
    const port = fake.port(ME, CALENDAR_AUTHORITY);
    const res = await port.applyBatch([
      {
        op: 'insert',
        table: 'calendars',
        values: {
          [Calendars._SYNC_ID]: 'c/b',
          [Calendars.NAME]: 'Personal',
          [Calendars.CALENDAR_DISPLAY_NAME]: 'Personal',
          [Calendars.CALENDAR_COLOR]: -16776961,
          [Calendars.CALENDAR_ACCESS_LEVEL]: 700,
          [Calendars.OWNER_ACCOUNT]: ME,
          [Calendars.SYNC_EVENTS]: 1,
        },
      },
    ]);
    if (!res.ok) throw new Error(res.message);
    return { port, calendarId: res.results[0].id! };
  }

  it('requires the calendar columns the provider requires', async () => {
    const fake = new FakeDeviceProviders();
    const port = fake.port(ME, CALENDAR_AUTHORITY);
    const res = await port.applyBatch([{ op: 'insert', table: 'calendars', values: { [Calendars.NAME]: 'x' } }]);
    expect(res).toMatchObject({ ok: false, reason: 'provider' });
  });

  it('enforces recurring/exception column rules, all-day fixes and the NULL-status crash', async () => {
    const fake = new FakeDeviceProviders();
    const { port, calendarId } = await calendar(fake);
    const base = { [Events.CALENDAR_ID]: calendarId, [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 };
    const master = await port.applyBatch([
      { op: 'insert', table: 'events', values: { ...base, [Events._SYNC_ID]: 'c/e1', [Events.DTSTART]: 1_000, [Events.DTEND]: 5_000, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'P3600S' } },
    ]);
    if (!master.ok) throw new Error(master.message);
    const m = fake.row('events', master.results[0].id!)!;
    expect(m[Events.DTEND]).toBeNull();
    expect(m[Events.ORGANIZER]).toBe(ME);
    expect(await port.applyBatch([{ op: 'insert', table: 'events', values: { ...base, [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=DAILY' } }])).toMatchObject({ ok: false });
    expect(await port.applyBatch([{ op: 'insert', table: 'events', values: { ...base, [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=YEARLY;RSCALE=CHINESE', [Events.DURATION]: 'P1D' } }])).toMatchObject({ ok: false });
    expect(await port.applyBatch([{ op: 'insert', table: 'events', values: { ...base, [Events.ALL_DAY]: 1, [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'PT0S' } }])).toMatchObject({ ok: false });
    const allDay = await port.applyBatch([
      { op: 'insert', table: 'events', values: { ...base, [Events.ALL_DAY]: 1, [Events.DTSTART]: 86_400_000 + 3_600_000, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'P86400S' } },
    ]);
    if (!allDay.ok) throw new Error(allDay.message);
    expect(fake.row('events', allDay.results[0].id!)).toMatchObject({ [Events.DTSTART]: 86_400_000, [Events.DURATION]: 'P1D' });
    expect(await port.applyBatch([{ op: 'update', table: 'events', id: master.results[0].id!, values: { [Events.STATUS]: null } }])).toMatchObject({ ok: false });
    expect(await port.applyBatch([{ op: 'update', table: 'events', id: master.results[0].id!, values: { [Events.SELF_ATTENDEE_STATUS]: 1 } }])).toMatchObject({ ok: false });
  });

  it('links exceptions to their master and keeps them when a sync adapter deletes the master', async () => {
    const fake = new FakeDeviceProviders();
    const { port, calendarId } = await calendar(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'events', values: { [Events.CALENDAR_ID]: calendarId, [Events._SYNC_ID]: 'c/e1', [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'P3600S', [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 } },
      { op: 'insert', table: 'events', values: { [Events.CALENDAR_ID]: calendarId, [Events.ORIGINAL_SYNC_ID]: 'c/e1', [Events.ORIGINAL_INSTANCE_TIME]: 86_400_000, [Events.DTSTART]: 86_400_000, [Events.DTEND]: 90_000_000, [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 } },
    ]);
    if (!res.ok) throw new Error(res.message);
    const [masterId, exceptionId] = res.results.map((r) => r.id!);
    expect(fake.row('events', exceptionId)![Events.ORIGINAL_ID]).toBe(masterId);
    await port.applyBatch([{ op: 'update', table: 'events', id: masterId, values: { [Events._SYNC_ID]: 'c/e9' } }]);
    expect(fake.row('events', exceptionId)![Events.ORIGINAL_SYNC_ID]).toBe('c/e9');
    await port.applyBatch([{ op: 'delete', table: 'events', id: masterId }]);
    expect(fake.row('events', exceptionId)).toBeDefined();
  });

  it('hard-deletes app-deleted events without _SYNC_ID and soft-deletes synced ones', async () => {
    const fake = new FakeDeviceProviders();
    const { calendarId } = await calendar(fake);
    const local = fake.user.insertEvent(calendarId, { [Events.DTSTART]: 0, [Events.DTEND]: 1000, [Events.EVENT_TIMEZONE]: 'UTC', [Events.TITLE]: 'x', [Events.STATUS]: 1 });
    expect(fake.row('events', local)).toMatchObject({ [Events.DIRTY]: 1, [Events.MUTATORS]: expect.any(String) });
    fake.user.deleteEvent(local);
    expect(fake.row('events', local)).toBeUndefined();
    const synced = fake.user.insertEvent(calendarId, { [Events.DTSTART]: 0, [Events.DTEND]: 1000, [Events.EVENT_TIMEZONE]: 'UTC', [Events._SYNC_ID]: '~pending/u1', [Events.STATUS]: 1 }, { reminders: [{ minutes: 10, method: 1 }] });
    fake.user.deleteEvent(synced);
    expect(fake.row('events', synced)).toMatchObject({ [Events.DELETED]: 1, [Events.DIRTY]: 1 });
    expect(fake.rows('reminders', 'event_id = ?', [synced])).toHaveLength(0);
  });

  it('models CONTENT_EXCEPTION_URI: only the exception is dirty; a split clones _SYNC_ID', async () => {
    const fake = new FakeDeviceProviders();
    const { port, calendarId } = await calendar(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'events', values: { [Events.CALENDAR_ID]: calendarId, [Events._SYNC_ID]: 'c/e1', [Events.UID_2445]: 'u1', [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'P3600S', [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 } },
      { op: 'insert', table: 'attendees', values: { [Attendees.ATTENDEE_EMAIL]: ME, [Attendees.ATTENDEE_STATUS]: 3 }, refs: { event_id: 0 } },
    ]);
    if (!res.ok) throw new Error(res.message);
    const masterId = res.results[0].id!;
    const ex = fake.user.exceptionViaUri(masterId, 86_400_000, { [Events.SELF_ATTENDEE_STATUS]: 1 });
    expect(fake.row('events', masterId)![Events.DIRTY]).toBe(0);
    expect(fake.row('events', ex)).toMatchObject({ [Events.DIRTY]: 1, [Events._SYNC_ID]: null, [Events.UID_2445]: 'u1', [Events.ORIGINAL_SYNC_ID]: 'c/e1' });
    expect(fake.rows('attendees', 'event_id = ?', [ex])[0][Attendees.ATTENDEE_STATUS]).toBe(1);
    const split = fake.user.splitViaUri(masterId, 5 * 86_400_000, '20260101T000000Z', {});
    expect(fake.row('events', split)![Events._SYNC_ID]).toBe('c/e1');
    expect(fake.row('events', masterId)![Events.RRULE]).toContain('UNTIL=20260101T000000Z');
    expect(fake.row('events', masterId)![Events.DIRTY]).toBe(0);
  });
});

describe('AOSP format checks', () => {
  it('accepts the Duration forms calendarcommon2 parses', () => {
    for (const ok of ['P1D', 'PT1H30M', 'P1DT2H', 'P2W', 'P1W2D', '-PT15M', 'P3600S', 'P0DT1H30M0S']) expect(aospDurationValid(ok)).toBe(true);
    for (const bad of ['1D', 'P1Y', 'PT1.5S', 'P', '']) expect(aospDurationValid(bad)).toBe(false);
  });

  it('rejects RRULE parts EventRecurrence does not know', () => {
    expect(aospRruleValid('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU;X-FOO=1')).toBe(true);
    expect(aospRruleValid('RRULE:FREQ=DAILY')).toBe(false);
    expect(aospRruleValid('FREQ=YEARLY;RSCALE=GREGORIAN;SKIP=OMIT')).toBe(false);
    expect(aospRruleValid('COUNT=2')).toBe(false);
  });
});
