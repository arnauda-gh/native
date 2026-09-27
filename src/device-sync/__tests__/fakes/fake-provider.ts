/**
 * In-memory stand-in for Android's Contacts and Calendar providers, as the
 * device sync engine reaches them through the native bridge (`ProviderPort`),
 * plus a "user" face that edits rows the way Contacts and Calendar apps do.
 *
 * It models the provider behaviour the engine relies on (docs/device-sync.md,
 * "Device data model", and the AOSP facts quoted there):
 *
 * - Sync-adapter writes never set DIRTY; app writes do (data rows, events and
 *   their attendees/reminders). The provider never clears DIRTY.
 * - RawContacts.VERSION goes up on every data-row insert, update or delete,
 *   whoever makes it, and on a DELETED change; never for DIRTY, SOURCE_ID or
 *   SYNC1-4. Groups bump VERSION on every update.
 * - App deletes are soft for raw contacts (always) and for events with a
 *   `_sync_id`; an app-deleted event without one is gone at once. Sync-adapter
 *   deletes are hard, and an event's exceptions survive the master.
 * - Batches are atomic here (a real provider may commit at yield points under
 *   contention; the engine must not rely on either), at most 499 contacts ops
 *   between yield points, asserts compare as text.
 * - Normalisation: a lone display name is split, missing display name and
 *   formatted address are derived, the organizer defaults to the calendar
 *   owner, all-day times are zeroed in UTC and `P<n>S` all-day durations become
 *   `P<n>D`, while `PT0S`-style all-day durations, NULL STATUS updates,
 *   SELF_ATTENDEE_STATUS updates and RRULEs with unknown parts fail the batch.
 * - Scoping: rows of other accounts are invisible and untouchable.
 *
 * Pure TypeScript, for vitest only.
 */
import {
  Attendees,
  Calendars,
  Colors,
  ContactsSettings,
  Data,
  Events,
  ExtendedProperties,
  GroupMembership,
  Groups,
  MimeType,
  RawContacts,
  Reminders,
  StructuredName,
  StructuredPostal,
} from '../../android-columns';
import {
  CALENDAR_AUTHORITY,
  CALENDAR_TABLES,
  CONTACTS_AUTHORITY,
  CONTACTS_TABLES,
  type Authority,
  type BatchFailure,
  type BatchResult,
  type Cell,
  type OpResult,
  type PhotoData,
  type ProviderOp,
  type ProviderPort,
  type ProviderQuery,
  type ProviderRows,
  type ProviderTable,
  type Row,
  type WriteCell,
  type WriteRow,
} from '../../types';
import { compileOrderBy, compileWhere, whereColumns } from './fake-sql';

export const FAKE_ACCOUNT_TYPE = 'com.anonymous.bulwarkmobile.account';
const APP_PACKAGE = 'com.example.calendarapp';

type StoredRow = Record<string, Cell>;

/** Rows keyed by `_id`, which every stored row also carries as a column. */
class RowMap extends Map<number, StoredRow> {
  override set(id: number, row: StoredRow): this {
    row._id = id;
    return super.set(id, row);
  }
}
type Tables = Record<ProviderTable, RowMap>;

const numbered = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

const COLUMNS: Record<ProviderTable, Set<string>> = {
  raw_contacts: new Set([...Object.values(RawContacts), 'custom_ringtone', 'send_to_voicemail', 'backup_id']),
  data: new Set([...Object.values(Data), GroupMembership.GROUP_SOURCE_ID]),
  groups: new Set([...Object.values(Groups), 'auto_add', 'favorites']),
  settings: new Set(Object.values(ContactsSettings)),
  calendars: new Set([...Object.values(Calendars), ...numbered('cal_sync', 4, 10), 'canPartiallyUpdate']),
  events: new Set([...Object.values(Events), ...numbered('sync_data', 7, 10), 'lastSynced']),
  attendees: new Set(Object.values(Attendees)),
  reminders: new Set(Object.values(Reminders)),
  extended_properties: new Set(Object.values(ExtendedProperties)),
  colors: new Set(Object.values(Colors)),
};

/** Columns only the provider computes; writes to them are refused like SQLite would for a view. */
const READ_ONLY_COLUMNS: Partial<Record<ProviderTable, Set<string>>> = {
  data: new Set([GroupMembership.GROUP_SOURCE_ID]),
  events: new Set([Events.ACCOUNT_NAME, Events.ACCOUNT_TYPE]),
};

class FakeProviderError extends Error {
  constructor(readonly reason: BatchFailure, message: string) {
    super(message);
  }
}

const isEmpty = (v: Cell | undefined) => v === null || v === undefined || v === '';

/** AOSP calendarcommon2 Duration.parse: `[+-]P` then `<digits><W|D|H|M|S>`, `T` ignored. */
export function aospDurationValid(value: string): boolean {
  return /^[+-]?P(T?\d+[WDHMS])*T?$/.test(value) && /\d/.test(value);
}

/** AOSP EventRecurrence.parse: known parts only (X-* ignored), FREQ required, no RRULE: prefix. */
export function aospRruleValid(value: string): boolean {
  const known = new Set([
    'FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY',
    'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST',
  ]);
  return value.split('\n').every((rule) => {
    const seen = new Set<string>();
    let freq = false;
    for (const part of rule.toUpperCase().split(';')) {
      if (!part) continue;
      const [name] = part.split('=');
      if (name.startsWith('X-')) continue;
      if (!known.has(name) || seen.has(name)) return false;
      seen.add(name);
      if (name === 'FREQ') freq = true;
    }
    return freq;
  });
}

export interface FakeProviderOptions {
  accountType?: string;
  /** Derive/split names and addresses like ContactsProvider (default true). */
  normalize?: boolean;
  /** Byte budget of one applyBatch before it fails with `tooLarge` (default 1 MB). */
  maxBatchBytes?: number;
}

/**
 * Both providers of one device. `port(account, authority)` is what the engine
 * gets; `user` edits like apps do; the rest is for test setup and assertions.
 */
export class FakeDeviceProviders {
  readonly accountType: string;
  private readonly normalize: boolean;
  private readonly maxBatchBytes: number;
  private tables: Tables = FakeDeviceProviders.emptyTables();
  private syncState = new Map<string, string>();
  private photos = new Map<number, string>();
  private nextId = 1;
  private nextPhotoFile = 1000;
  private pendingFailure: { reason: BatchFailure; message: string } | null = null;
  private beforeBatch: Array<() => void> = [];
  /** Every batch applied or refused, for assertions on write counts. */
  readonly batches: Array<{ account: string; authority: Authority; ops: ProviderOp[]; ok: boolean }> = [];

  readonly user = new FakeUser(this);

  constructor(options: FakeProviderOptions = {}) {
    this.accountType = options.accountType ?? FAKE_ACCOUNT_TYPE;
    this.normalize = options.normalize ?? true;
    this.maxBatchBytes = options.maxBatchBytes ?? 1_000_000;
  }

  private static emptyTables(): Tables {
    return {
      raw_contacts: new RowMap(),
      data: new RowMap(),
      groups: new RowMap(),
      settings: new RowMap(),
      calendars: new RowMap(),
      events: new RowMap(),
      attendees: new RowMap(),
      reminders: new RowMap(),
      extended_properties: new RowMap(),
      colors: new RowMap(),
    };
  }

  port(accountName: string, authority: Authority): ProviderPort {
    return new FakePort(this, accountName, authority);
  }

  // ── test hooks ─────────────────────────────────────────

  /** The next applyBatch fails with this reason, applying nothing. */
  failNextBatch(reason: BatchFailure, message = `injected ${reason}`): void {
    this.pendingFailure = { reason, message };
  }

  /** Runs `fn` right before the next applyBatch is applied (a concurrent user edit). */
  beforeNextBatch(fn: () => void): void {
    this.beforeBatch.push(fn);
  }

  /** Removes an account the way AccountManager does: the providers drop all its rows and SyncState. */
  removeAccount(accountName: string): void {
    for (const table of ['raw_contacts', 'groups', 'settings', 'calendars', 'colors'] as const) {
      for (const [id, row] of this.tables[table]) {
        if (row.account_name === accountName && row.account_type === this.accountType) this.deleteRow(table, id);
      }
    }
    for (const authority of [CONTACTS_AUTHORITY, CALENDAR_AUTHORITY]) this.syncState.delete(`${authority}|${accountName}`);
  }

  // ── inspection ─────────────────────────────────────────

  rows(table: ProviderTable, where?: string, args: Array<string | number> = []): Row[] {
    const pred = compileWhere(where, args);
    return [...this.tables[table].values()]
      .filter((row) => pred((c) => this.readCell(table, row, c)))
      .map((row) => ({ ...this.view(table, row) }));
  }

  row(table: ProviderTable, id: number): Row | undefined {
    const row = this.tables[table].get(id);
    return row ? { ...this.view(table, row) } : undefined;
  }

  /** Stored photo bytes (base64) by PHOTO_FILE_ID. */
  photo(fileId: number): string | undefined {
    return this.photos.get(fileId);
  }

  readSyncState(accountName: string, authority: Authority): string | null {
    return this.syncState.get(`${authority}|${accountName}`) ?? null;
  }

  // ── internals shared by the port and the user face ─────

  /** @internal */ allocId(): number {
    return this.nextId++;
  }

  /** @internal */ table(table: ProviderTable): RowMap {
    return this.tables[table];
  }

  /** @internal */ readCell(table: ProviderTable, row: StoredRow, column: string): Cell {
    if (table === 'data' && column === GroupMembership.GROUP_SOURCE_ID) {
      if (row[Data.MIMETYPE] !== MimeType.GROUP_MEMBERSHIP || row[Data.DATA1] === null) return null;
      return this.tables.groups.get(Number(row[Data.DATA1]))?.[Groups.SOURCE_ID] ?? null;
    }
    if (table === 'events' && (column === Events.ACCOUNT_NAME || column === Events.ACCOUNT_TYPE)) {
      return this.tables.calendars.get(Number(row[Events.CALENDAR_ID]))?.[column] ?? null;
    }
    if (table === 'data' && column === Data.DATA15 && row[Data.MIMETYPE] === MimeType.PHOTO) return null;
    const v = row[column];
    return v === undefined ? null : v;
  }

  private view(table: ProviderTable, row: StoredRow): StoredRow {
    const out: StoredRow = {};
    for (const column of COLUMNS[table]) out[column] = this.readCell(table, row, column);
    return out;
  }

  /** @internal */ owned(table: ProviderTable, row: StoredRow, accountName: string): boolean {
    const mine = (r: StoredRow | undefined) =>
      !!r && r[RawContacts.ACCOUNT_NAME] === accountName && r[RawContacts.ACCOUNT_TYPE] === this.accountType;
    switch (table) {
      case 'raw_contacts':
      case 'groups':
      case 'settings':
      case 'calendars':
      case 'colors':
        return mine(row);
      case 'data':
        return mine(this.tables.raw_contacts.get(Number(row[Data.RAW_CONTACT_ID])));
      case 'events':
        return mine(this.tables.calendars.get(Number(row[Events.CALENDAR_ID])));
      case 'attendees':
      case 'reminders':
      case 'extended_properties': {
        const event = this.tables.events.get(Number(row.event_id));
        return !!event && this.owned('events', event, accountName);
      }
    }
  }

  /** @internal */ deleteRow(table: ProviderTable, id: number): void {
    const row = this.tables[table].get(id);
    if (!row) return;
    this.tables[table].delete(id);
    if (table === 'raw_contacts') {
      for (const [dataId, d] of this.tables.data) if (d[Data.RAW_CONTACT_ID] === id) this.tables.data.delete(dataId);
    } else if (table === 'groups') {
      for (const [dataId, d] of this.tables.data) {
        if (d[Data.MIMETYPE] === MimeType.GROUP_MEMBERSHIP && Number(d[Data.DATA1]) === id) {
          this.tables.data.delete(dataId);
          this.bumpVersion(Number(d[Data.RAW_CONTACT_ID]));
        }
      }
    } else if (table === 'calendars') {
      for (const [eventId, e] of this.tables.events) if (e[Events.CALENDAR_ID] === id) this.deleteRow('events', eventId);
    } else if (table === 'events') {
      for (const child of ['attendees', 'reminders', 'extended_properties'] as const) {
        for (const [childId, c] of this.tables[child]) if (c.event_id === id) this.tables[child].delete(childId);
      }
    }
  }

  /** @internal */ bumpVersion(rawContactId: number): void {
    const rc = this.tables.raw_contacts.get(rawContactId);
    if (rc) rc[RawContacts.VERSION] = Number(rc[RawContacts.VERSION] ?? 1) + 1;
  }

  /** @internal */ markEventDirty(eventId: number): void {
    const e = this.tables.events.get(eventId);
    if (!e) return;
    e[Events.DIRTY] = 1;
    const mutators = String(e[Events.MUTATORS] ?? '');
    if (!mutators.split(',').includes(APP_PACKAGE)) e[Events.MUTATORS] = mutators ? `${mutators},${APP_PACKAGE}` : APP_PACKAGE;
  }

  /** @internal */ storePhoto(b64: string): number {
    const fileId = this.nextPhotoFile++;
    this.photos.set(fileId, b64);
    return fileId;
  }

  /** @internal Provider-side fixes of a data row after a write (ContactsProvider's row handlers). */
  normalizeData(row: StoredRow): void {
    if (!this.normalize) return;
    if (row[Data.MIMETYPE] === MimeType.STRUCTURED_NAME) {
      const parts = [
        StructuredName.PREFIX,
        StructuredName.GIVEN_NAME,
        StructuredName.MIDDLE_NAME,
        StructuredName.FAMILY_NAME,
        StructuredName.SUFFIX,
      ];
      const anyPart = parts.some((c) => !isEmpty(row[c]));
      if (isEmpty(row[StructuredName.DISPLAY_NAME]) && anyPart) {
        row[StructuredName.DISPLAY_NAME] = parts.map((c) => row[c]).filter((v) => !isEmpty(v)).join(' ');
      } else if (!isEmpty(row[StructuredName.DISPLAY_NAME]) && !anyPart) {
        const words = String(row[StructuredName.DISPLAY_NAME]).trim().split(/\s+/);
        row[StructuredName.GIVEN_NAME] = words[0] ?? null;
        row[StructuredName.FAMILY_NAME] = words.length > 1 ? words.slice(1).join(' ') : null;
      }
    } else if (row[Data.MIMETYPE] === MimeType.STRUCTURED_POSTAL) {
      const parts = [
        StructuredPostal.STREET,
        StructuredPostal.POBOX,
        StructuredPostal.NEIGHBORHOOD,
        StructuredPostal.CITY,
        StructuredPostal.REGION,
        StructuredPostal.POSTCODE,
        StructuredPostal.COUNTRY,
      ];
      const anyPart = parts.some((c) => !isEmpty(row[c]));
      if (isEmpty(row[StructuredPostal.FORMATTED_ADDRESS]) && anyPart) {
        row[StructuredPostal.FORMATTED_ADDRESS] = parts.map((c) => row[c]).filter((v) => !isEmpty(v)).join(', ');
      } else if (!isEmpty(row[StructuredPostal.FORMATTED_ADDRESS]) && !anyPart) {
        row[StructuredPostal.STREET] = row[StructuredPostal.FORMATTED_ADDRESS];
      }
    }
  }

  /** @internal CalendarProvider's checks and fixes of an event row (sync adapter and app alike). */
  fixEvent(row: StoredRow, isInsert: boolean): void {
    const recurring = !isEmpty(row[Events.RRULE]) || !isEmpty(row[Events.RDATE]);
    const exception = !isEmpty(row[Events.ORIGINAL_SYNC_ID]) || !isEmpty(row[Events.ORIGINAL_ID]);
    if (!isEmpty(row[Events.RRULE]) && !aospRruleValid(String(row[Events.RRULE]))) {
      throw new FakeProviderError('provider', `Invalid recurrence rule: ${row[Events.RRULE]}`);
    }
    if (recurring) {
      row[Events.DTEND] = null;
      if (isEmpty(row[Events.DURATION])) throw new FakeProviderError('provider', 'Recurring event without DURATION');
    } else if (exception || !isEmpty(row[Events.DTEND])) {
      row[Events.DURATION] = null;
    }
    if (!isEmpty(row[Events.DURATION]) && !aospDurationValid(String(row[Events.DURATION]))) {
      throw new FakeProviderError('provider', `Invalid DURATION ${row[Events.DURATION]}`);
    }
    if (isInsert && isEmpty(row[Events.DTSTART])) throw new FakeProviderError('provider', 'DTSTART field missing');
    if (Number(row[Events.ALL_DAY]) === 1) {
      for (const c of [Events.DTSTART, Events.DTEND]) {
        if (!isEmpty(row[c])) row[c] = Math.floor(Number(row[c]) / 86_400_000) * 86_400_000;
      }
      const d = row[Events.DURATION];
      if (!isEmpty(d)) {
        const s = String(d);
        if (s.endsWith('S')) {
          const n = Number(s.substring(1, s.length - 1)); // Integer.parseInt(duration.substring(1, len-1))
          if (!Number.isInteger(n)) throw new FakeProviderError('provider', `NumberFormatException: ${s}`);
          row[Events.DURATION] = `P${Math.ceil(n / 86_400)}D`;
        }
      }
    }
  }

  /** @internal */ applyBatch(accountName: string, authority: Authority, ops: ProviderOp[]): BatchResult {
    const record = (ok: boolean) => this.batches.push({ account: accountName, authority, ops, ok });
    if (this.pendingFailure) {
      const { reason, message } = this.pendingFailure;
      this.pendingFailure = null;
      record(false);
      return { ok: false, reason, message };
    }
    if (JSON.stringify(ops).length > this.maxBatchBytes) {
      record(false);
      return { ok: false, reason: 'tooLarge', message: 'TransactionTooLargeException' };
    }
    if (authority === CONTACTS_AUTHORITY) {
      let sinceYield = 0;
      for (let i = 0; i < ops.length; i++) {
        if (i > 0 && ops[i].yieldAllowed) sinceYield = 0;
        if (++sinceYield >= 500) {
          record(false);
          return { ok: false, reason: 'provider', message: 'Too many content provider operations between yield points' };
        }
      }
    }
    for (const hook of this.beforeBatch.splice(0)) hook();

    const snapshot = {
      tables: cloneTables(this.tables),
      syncState: new Map(this.syncState),
      photos: new Map(this.photos),
      nextId: this.nextId,
      nextPhotoFile: this.nextPhotoFile,
    };
    try {
      const results = new BatchApplier(this, accountName, authority).apply(ops);
      record(true);
      return { ok: true, results };
    } catch (e) {
      this.tables = snapshot.tables;
      this.syncState = snapshot.syncState;
      this.photos = snapshot.photos;
      this.nextId = snapshot.nextId;
      this.nextPhotoFile = snapshot.nextPhotoFile;
      record(false);
      if (e instanceof FakeProviderError) return { ok: false, reason: e.reason, message: e.message };
      return { ok: false, reason: 'provider', message: (e as Error).message };
    }
  }

  /** @internal */ setSyncState(accountName: string, authority: Authority, value: string): void {
    this.syncState.set(`${authority}|${accountName}`, value);
  }
}

function cloneTables(tables: Tables): Tables {
  const out = {} as Tables;
  for (const [name, rows] of Object.entries(tables) as Array<[ProviderTable, RowMap]>) {
    const copy = new RowMap();
    for (const [id, row] of rows) copy.set(id, { ...row });
    out[name] = copy;
  }
  return out;
}

function tablesFor(authority: Authority): readonly ProviderTable[] {
  return authority === CONTACTS_AUTHORITY ? CONTACTS_TABLES : CALENDAR_TABLES;
}

function checkColumns(table: ProviderTable, columns: Iterable<string>, write: boolean): void {
  for (const c of columns) {
    if (!COLUMNS[table].has(c)) throw new FakeProviderError('provider', `no such column: ${c} in ${table}`);
    if (write && READ_ONLY_COLUMNS[table]?.has(c)) throw new FakeProviderError('provider', `${c} is read-only in ${table}`);
  }
}

class FakePort implements ProviderPort {
  constructor(
    private readonly fake: FakeDeviceProviders,
    readonly accountName: string,
    readonly authority: Authority,
  ) {}

  async query(q: ProviderQuery): Promise<ProviderRows> {
    if (!tablesFor(this.authority).includes(q.table)) {
      throw new Error(`scope: table ${q.table} is not part of ${this.authority}`);
    }
    try {
      checkColumns(q.table, [...q.columns, ...whereColumns(q.where)], false);
    } catch (e) {
      throw new Error((e as Error).message);
    }
    const pred = compileWhere(q.where, q.args);
    const order = compileOrderBy(q.orderBy);
    const rows = [...this.fake.table(q.table).values()]
      .filter((row) => this.fake.owned(q.table, row, this.accountName))
      .filter((row) => pred((c) => this.fake.readCell(q.table, row, c)))
      .sort((a, b) => order((c) => this.fake.readCell(q.table, a, c), (c) => this.fake.readCell(q.table, b, c)));
    return {
      columns: q.columns,
      rows: rows.map((row) => q.columns.map((c) => this.fake.readCell(q.table, row, c))),
    };
  }

  async applyBatch(ops: ProviderOp[]): Promise<BatchResult> {
    return this.fake.applyBatch(this.accountName, this.authority, structuredClone(ops));
  }

  async readSyncState(): Promise<string | null> {
    return this.fake.readSyncState(this.accountName, this.authority);
  }

  async readPhoto(rawContactId: number, _maxPx: number): Promise<PhotoData | null> {
    const rc = this.fake.table('raw_contacts').get(rawContactId);
    if (!rc || !this.fake.owned('raw_contacts', rc, this.accountName)) throw new Error('scope: raw contact of another account');
    for (const row of this.fake.table('data').values()) {
      if (row[Data.RAW_CONTACT_ID] === rawContactId && row[Data.MIMETYPE] === MimeType.PHOTO) {
        const fileId = row[Data.DATA14] === null ? null : Number(row[Data.DATA14]);
        const b64 = fileId === null ? undefined : this.fake.photo(fileId);
        return b64 === undefined ? null : { jpegBase64: b64, fileId };
      }
    }
    return null;
  }
}

/** Applies one batch as a sync adapter; throws FakeProviderError to roll it back. */
class BatchApplier {
  private readonly results: OpResult[] = [];
  private readonly insertedDataFor = new Set<number>();

  constructor(
    private readonly fake: FakeDeviceProviders,
    private readonly account: string,
    private readonly authority: Authority,
  ) {}

  apply(ops: ProviderOp[]): OpResult[] {
    ops.forEach((op, index) => this.results.push(this.applyOne(op, index)));
    // Data-row inserts bump each raw contact's VERSION once per transaction.
    for (const id of this.insertedDataFor) this.fake.bumpVersion(id);
    return this.results;
  }

  private scopeError(msg: string): never {
    throw new FakeProviderError('scope', msg);
  }

  private checkTable(table: ProviderTable): void {
    if (!tablesFor(this.authority).includes(table)) this.scopeError(`table ${table} is not part of ${this.authority}`);
  }

  private target(table: ProviderTable, id: number | undefined, where: string | undefined, args: Array<string | number> | undefined): number[] {
    const rows = this.fake.table(table);
    if (id !== undefined) {
      const row = rows.get(id);
      if (!row) return [];
      if (!this.fake.owned(table, row, this.account)) this.scopeError(`${table} ${id} belongs to another account`);
      return [id];
    }
    checkColumns(table, whereColumns(where), false);
    const pred = compileWhere(where, args);
    return [...rows]
      .filter(([, row]) => this.fake.owned(table, row, this.account))
      .filter(([, row]) => pred((c) => this.fake.readCell(table, row, c)))
      .map(([rowId]) => rowId);
  }

  private values(table: ProviderTable, values: WriteRow): StoredRow {
    checkColumns(table, Object.keys(values), true);
    const out: StoredRow = {};
    for (const [column, cell] of Object.entries(values) as Array<[string, WriteCell]>) {
      if (cell !== null && typeof cell === 'object') {
        if (!(table === 'data' && column === Data.DATA15)) this.scopeError(`blob not allowed in ${table}.${column}`);
        out[column] = `blob:${cell.b64}`;
      } else {
        out[column] = cell;
      }
    }
    return out;
  }

  /** A photo row's full-size bytes become a stored display photo plus a file id, like PhotoProcessor. */
  private processPhoto(row: StoredRow): void {
    const v = row[Data.DATA15];
    if (typeof v === 'string' && v.startsWith('blob:')) {
      row[Data.DATA14] = this.fake.storePhoto(v.slice(5));
      row[Data.DATA15] = 'thumbnail';
    }
  }

  private applyOne(op: ProviderOp, index: number): OpResult {
    if (op.op === 'syncState') {
      this.fake.setSyncState(this.account, this.authority, op.value);
      return {};
    }
    this.checkTable(op.table);
    switch (op.op) {
      case 'insert':
        return this.insert(op.table, op.values, op.refs, index);
      case 'update':
        return this.update(op.table, op.id, op.where, op.args, op.values, op.expectCount);
      case 'delete':
        return this.delete(op.table, op.id, op.where, op.args, op.expectCount);
      case 'assert':
        return this.assert(op.table, op.id, op.where, op.args, op.values, op.expectCount);
    }
  }

  private insert(table: ProviderTable, values: WriteRow, refs: Record<string, number> | undefined, index: number): OpResult {
    const row = this.values(table, values);
    for (const [column, ref] of Object.entries(refs ?? {})) {
      if (ref >= index || this.results[ref]?.id === undefined) throw new FakeProviderError('provider', `bad back-reference ${ref}`);
      row[column] = this.results[ref].id!;
    }
    const id = this.fake.allocId();
    const account = { account_name: this.account, account_type: this.fake.accountType };
    const parentOwned = (parentTable: ProviderTable, parentId: Cell) => {
      const parent = this.fake.table(parentTable).get(Number(parentId));
      if (!parent || !this.fake.owned(parentTable, parent, this.account)) {
        this.scopeError(`${table} insert names ${parentTable} ${String(parentId)} outside the account`);
      }
      return parent;
    };
    const accountMismatch = (r: StoredRow) =>
      (r.account_name !== undefined && r.account_name !== this.account) ||
      (r.account_type !== undefined && r.account_type !== this.fake.accountType);
    switch (table) {
      case 'raw_contacts':
        if (accountMismatch(row)) this.scopeError('raw contact of another account');
        Object.assign(row, { ...defaults(RAW_CONTACT_DEFAULTS), ...row, ...account });
        break;
      case 'groups':
        if (accountMismatch(row)) this.scopeError('group of another account');
        Object.assign(row, { ...defaults(GROUP_DEFAULTS), ...row, ...account });
        break;
      case 'settings': {
        for (const [sid, s] of this.fake.table('settings')) {
          if (s.account_name === this.account && s.account_type === this.fake.accountType) this.fake.table('settings').delete(sid);
        }
        Object.assign(row, { [ContactsSettings.UNGROUPED_VISIBLE]: 0, [ContactsSettings.SHOULD_SYNC]: 1, ...row, ...account });
        break;
      }
      case 'data': {
        parentOwned('raw_contacts', row[Data.RAW_CONTACT_ID]);
        row[Data.RAW_CONTACT_ID] = Number(row[Data.RAW_CONTACT_ID]);
        if (isEmpty(row[Data.MIMETYPE])) throw new FakeProviderError('provider', 'data row without mimetype');
        row[Data.DATA_VERSION] = 0;
        if (row[Data.MIMETYPE] === MimeType.GROUP_MEMBERSHIP) this.resolveMembership(row);
        this.processPhoto(row);
        this.fake.normalizeData(row);
        this.insertedDataFor.add(Number(row[Data.RAW_CONTACT_ID]));
        break;
      }
      case 'calendars': {
        if (accountMismatch(row)) this.scopeError('calendar of another account');
        for (const c of [Calendars.NAME, Calendars.CALENDAR_DISPLAY_NAME, Calendars.CALENDAR_COLOR, Calendars.CALENDAR_ACCESS_LEVEL, Calendars.OWNER_ACCOUNT]) {
          if (isEmpty(row[c])) throw new FakeProviderError('provider', `calendar insert without ${c}`);
        }
        Object.assign(row, { ...defaults(CALENDAR_DEFAULTS), ...row, ...account });
        break;
      }
      case 'events': {
        const calendar = parentOwned('calendars', row[Events.CALENDAR_ID])!;
        row[Events.CALENDAR_ID] = Number(row[Events.CALENDAR_ID]);
        Object.assign(row, { ...defaults(EVENT_DEFAULTS), ...row });
        this.fake.fixEvent(row, true);
        if (isEmpty(row[Events.ORGANIZER])) row[Events.ORGANIZER] = calendar[Calendars.OWNER_ACCOUNT];
        this.linkException(row);
        const self = row[Events.SELF_ATTENDEE_STATUS];
        this.fake.table('events').set(id, row);
        if (!isEmpty(self)) {
          this.fake.table('attendees').set(this.fake.allocId(), {
            [Attendees.EVENT_ID]: id,
            [Attendees.ATTENDEE_EMAIL]: calendar[Calendars.OWNER_ACCOUNT],
            [Attendees.ATTENDEE_STATUS]: self,
          });
        }
        return { id };
      }
      case 'attendees':
      case 'reminders':
      case 'extended_properties':
        parentOwned('events', row.event_id);
        row.event_id = Number(row.event_id);
        break;
      case 'colors':
        if (accountMismatch(row)) this.scopeError('color of another account');
        Object.assign(row, { ...row, ...account });
        break;
    }
    this.fake.table(table).set(id, row);
    return { id };
  }

  private resolveMembership(row: StoredRow): void {
    const sourceId = row[GroupMembership.GROUP_SOURCE_ID];
    delete row[GroupMembership.GROUP_SOURCE_ID];
    if (row[Data.DATA1] !== null && row[Data.DATA1] !== undefined) return;
    if (isEmpty(sourceId)) throw new FakeProviderError('provider', 'membership needs GROUP_ROW_ID or GROUP_SOURCE_ID');
    for (const [gid, g] of this.fake.table('groups')) {
      if (g[Groups.SOURCE_ID] === sourceId && this.fake.owned('groups', g, this.account)) {
        row[Data.DATA1] = gid;
        return;
      }
    }
    // Like the provider: an unknown source id creates an empty, invisible group.
    const gid = this.fake.allocId();
    this.fake.table('groups').set(gid, {
      ...defaults(GROUP_DEFAULTS),
      [Groups.SOURCE_ID]: sourceId,
      account_name: this.account,
      account_type: this.fake.accountType,
    });
    row[Data.DATA1] = gid;
  }

  /** ORIGINAL_ID and ORIGINAL_SYNC_ID fill each other in from the master, as CalendarProvider does. */
  private linkException(row: StoredRow): void {
    const events = this.fake.table('events');
    if (!isEmpty(row[Events.ORIGINAL_SYNC_ID]) && isEmpty(row[Events.ORIGINAL_ID])) {
      for (const [mid, m] of events) {
        if (m[Events._SYNC_ID] === row[Events.ORIGINAL_SYNC_ID] && m[Events.CALENDAR_ID] === row[Events.CALENDAR_ID]) {
          row[Events.ORIGINAL_ID] = mid;
          break;
        }
      }
    } else if (!isEmpty(row[Events.ORIGINAL_ID]) && isEmpty(row[Events.ORIGINAL_SYNC_ID])) {
      row[Events.ORIGINAL_SYNC_ID] = events.get(Number(row[Events.ORIGINAL_ID]))?.[Events._SYNC_ID] ?? null;
    }
  }

  private update(
    table: ProviderTable,
    id: number | undefined,
    where: string | undefined,
    args: Array<string | number> | undefined,
    values: WriteRow,
    expectCount: number | undefined,
  ): OpResult {
    const ids = this.target(table, id, where, args);
    if (expectCount !== undefined && ids.length !== expectCount) {
      throw new FakeProviderError('assert', `wrong number of rows: ${ids.length}`);
    }
    const patch = this.values(table, values);
    for (const rowId of ids) {
      const row = this.fake.table(table).get(rowId)!;
      const before = { ...row };
      if (table === 'events') {
        if (Events.SELF_ATTENDEE_STATUS in patch) throw new FakeProviderError('provider', 'IllegalArgumentException: selfAttendeeStatus');
        if (Events.STATUS in patch && patch[Events.STATUS] === null) throw new FakeProviderError('provider', 'NullPointerException: eventStatus');
      }
      Object.assign(row, patch);
      switch (table) {
        case 'raw_contacts':
          if (before[RawContacts.DELETED] !== row[RawContacts.DELETED]) this.fake.bumpVersion(rowId);
          break;
        case 'groups':
          row[Groups.VERSION] = Number(row[Groups.VERSION] ?? 1) + 1;
          break;
        case 'data':
          row[Data.DATA_VERSION] = Number(row[Data.DATA_VERSION] ?? 0) + 1;
          this.processPhoto(row);
          this.fake.normalizeData(row);
          this.fake.bumpVersion(Number(row[Data.RAW_CONTACT_ID]));
          break;
        case 'events':
          this.fake.fixEvent(row, false);
          if (Events.DIRTY in patch && Number(patch[Events.DIRTY]) === 0) row[Events.MUTATORS] = null;
          if (before[Events._SYNC_ID] !== row[Events._SYNC_ID] && !isEmpty(before[Events._SYNC_ID])) {
            for (const e of this.fake.table('events').values()) {
              if (e[Events.ORIGINAL_SYNC_ID] === before[Events._SYNC_ID]) e[Events.ORIGINAL_SYNC_ID] = row[Events._SYNC_ID];
            }
          }
          break;
      }
    }
    return { count: ids.length };
  }

  private delete(
    table: ProviderTable,
    id: number | undefined,
    where: string | undefined,
    args: Array<string | number> | undefined,
    expectCount: number | undefined,
  ): OpResult {
    const ids = this.target(table, id, where, args);
    if (expectCount !== undefined && ids.length !== expectCount) {
      throw new FakeProviderError('assert', `wrong number of rows: ${ids.length}`);
    }
    for (const rowId of ids) {
      const row = this.fake.table(table).get(rowId);
      if (!row) continue;
      if (table === 'data') this.fake.bumpVersion(Number(row[Data.RAW_CONTACT_ID]));
      this.fake.deleteRow(table, rowId);
    }
    return { count: ids.length };
  }

  private assert(
    table: ProviderTable,
    id: number | undefined,
    where: string | undefined,
    args: Array<string | number> | undefined,
    values: Row | undefined,
    expectCount: number | undefined,
  ): OpResult {
    const ids = this.target(table, id, where, args);
    if (expectCount !== undefined && ids.length !== expectCount) {
      throw new FakeProviderError('assert', `wrong number of rows: ${ids.length}`);
    }
    if (values) {
      checkColumns(table, Object.keys(values), false);
      for (const rowId of ids) {
        const row = this.fake.table(table).get(rowId)!;
        for (const [column, expected] of Object.entries(values)) {
          const actual = this.fake.readCell(table, row, column);
          const same = actual === null || expected === null ? actual === expected : String(actual) === String(expected);
          if (!same) {
            throw new FakeProviderError('assert', `Found value ${String(actual)} when expected ${String(expected)} for column ${column}`);
          }
        }
      }
    }
    return { count: ids.length };
  }
}

const defaults = (d: StoredRow): StoredRow => ({ ...d });

const RAW_CONTACT_DEFAULTS: StoredRow = {
  [RawContacts.SOURCE_ID]: null,
  [RawContacts.VERSION]: 1,
  [RawContacts.DIRTY]: 0,
  [RawContacts.DELETED]: 0,
  [RawContacts.SYNC1]: null,
  [RawContacts.SYNC2]: null,
  [RawContacts.SYNC3]: null,
  [RawContacts.SYNC4]: null,
  [RawContacts.RAW_CONTACT_IS_READ_ONLY]: 0,
  [RawContacts.AGGREGATION_MODE]: 0,
  [RawContacts.STARRED]: 0,
};

const GROUP_DEFAULTS: StoredRow = {
  [Groups.SOURCE_ID]: null,
  [Groups.VERSION]: 1,
  [Groups.DIRTY]: 0,
  [Groups.DELETED]: 0,
  [Groups.GROUP_VISIBLE]: 0,
  [Groups.SHOULD_SYNC]: 1,
  [Groups.GROUP_IS_READ_ONLY]: 0,
  auto_add: 0,
  favorites: 0,
};

const CALENDAR_DEFAULTS: StoredRow = {
  [Calendars.VISIBLE]: 1,
  [Calendars.SYNC_EVENTS]: 0,
  [Calendars.ALLOWED_REMINDERS]: '0,1',
  [Calendars.ALLOWED_AVAILABILITY]: '0,1',
  [Calendars.ALLOWED_ATTENDEE_TYPES]: '0,1,2',
  [Calendars.MAX_REMINDERS]: 5,
  [Calendars.CAN_ORGANIZER_RESPOND]: 1,
  [Calendars.CAN_MODIFY_TIME_ZONE]: 1,
  [Calendars.DIRTY]: 0,
};

const EVENT_DEFAULTS: StoredRow = {
  [Events.DIRTY]: 0,
  [Events.DELETED]: 0,
  [Events.AVAILABILITY]: 0,
  [Events.ACCESS_LEVEL]: 0,
  [Events.HAS_ATTENDEE_DATA]: 0,
  [Events.GUESTS_CAN_MODIFY]: 0,
  [Events.GUESTS_CAN_INVITE_OTHERS]: 1,
  [Events.GUESTS_CAN_SEE_GUESTS]: 1,
  [Events.ALL_DAY]: 0,
  [Events.STATUS]: 0,
};

/**
 * Edits as Contacts and Calendar apps make them (not a sync adapter): they
 * set DIRTY, soft-delete, and some re-insert rows. Named after the app whose
 * behaviour they copy where it matters.
 */
export class FakeUser {
  constructor(private readonly fake: FakeDeviceProviders) {}

  private rc(id: number): StoredRow {
    const rc = this.fake.table('raw_contacts').get(id);
    if (!rc) throw new Error(`no raw contact ${id}`);
    return rc;
  }

  private dirtyContact(id: number): void {
    this.rc(id)[RawContacts.DIRTY] = 1;
  }

  /** A new contact from a Contacts app: no SOURCE_ID, DIRTY once data rows exist. */
  insertContact(accountName: string, rows: Row[]): number {
    const id = this.fake.allocId();
    this.fake.table('raw_contacts').set(id, {
      ...defaults(RAW_CONTACT_DEFAULTS),
      account_name: accountName,
      account_type: this.fake.accountType,
    });
    for (const row of rows) this.insertData(id, row);
    return id;
  }

  insertData(rawContactId: number, values: Row): number {
    const id = this.fake.allocId();
    const row: StoredRow = { ...values, [Data.RAW_CONTACT_ID]: rawContactId, [Data.DATA_VERSION]: 0 };
    this.fake.normalizeData(row);
    this.fake.table('data').set(id, row);
    this.fake.bumpVersion(rawContactId);
    this.dirtyContact(rawContactId);
    return id;
  }

  /** AOSP Contacts: in-place update of the changed columns only (DATA_SYNC kept). */
  updateData(dataId: number, values: Row): void {
    const row = this.fake.table('data').get(dataId);
    if (!row) throw new Error(`no data row ${dataId}`);
    Object.assign(row, values);
    row[Data.DATA_VERSION] = Number(row[Data.DATA_VERSION] ?? 0) + 1;
    this.fake.normalizeData(row);
    const rcId = Number(row[Data.RAW_CONTACT_ID]);
    this.fake.bumpVersion(rcId);
    this.dirtyContact(rcId);
  }

  deleteData(dataId: number): void {
    const row = this.fake.table('data').get(dataId);
    if (!row) return;
    const rcId = Number(row[Data.RAW_CONTACT_ID]);
    this.fake.table('data').delete(dataId);
    this.fake.bumpVersion(rcId);
    this.dirtyContact(rcId);
  }

  /**
   * Fossify Contacts' save: the name row is updated in place, the rows of
   * every other kind it models are deleted and `rows` inserted without
   * DATA_SYNC; relations and foreign kinds are left alone. Also stars through
   * the aggregate, which dirties the raw contact.
   */
  fossifySave(rawContactId: number, name: Row | null, rows: Row[]): void {
    const modeled = new Set<string>([
      MimeType.NICKNAME, MimeType.PHONE, MimeType.EMAIL, MimeType.STRUCTURED_POSTAL, MimeType.EVENT,
      MimeType.NOTE, MimeType.ORGANIZATION, MimeType.WEBSITE, MimeType.GROUP_MEMBERSHIP,
      'vnd.android.cursor.item/im',
    ]);
    for (const [id, row] of [...this.fake.table('data')]) {
      if (row[Data.RAW_CONTACT_ID] !== rawContactId) continue;
      if (name && row[Data.MIMETYPE] === MimeType.STRUCTURED_NAME) this.updateData(id, name);
      else if (modeled.has(String(row[Data.MIMETYPE]))) this.deleteData(id);
    }
    for (const row of rows) this.insertData(rawContactId, row);
    this.dirtyContact(rawContactId);
  }

  /** Soft delete: DELETED=1, DIRTY=1, rows kept until the sync adapter purges them. */
  deleteContact(rawContactId: number): void {
    const rc = this.rc(rawContactId);
    if (Number(rc[RawContacts.DELETED]) !== 1) this.fake.bumpVersion(rawContactId);
    rc[RawContacts.DELETED] = 1;
    rc[RawContacts.DIRTY] = 1;
  }

  /** Starring through the aggregate marks the raw contact dirty (any app, even a sync adapter). */
  star(rawContactId: number, starred = true): void {
    const rc = this.rc(rawContactId);
    rc[RawContacts.STARRED] = starred ? 1 : 0;
    rc[RawContacts.DIRTY] = 1;
  }

  /** A new photo from an editor: a new display photo file id on the photo row. */
  setPhoto(rawContactId: number, jpegBase64: string): void {
    const fileId = this.fake.storePhoto(jpegBase64);
    for (const [id, row] of this.fake.table('data')) {
      if (row[Data.RAW_CONTACT_ID] === rawContactId && row[Data.MIMETYPE] === MimeType.PHOTO) {
        this.updateData(id, { [Data.DATA14]: fileId, [Data.DATA15]: 'thumbnail' });
        return;
      }
    }
    this.insertData(rawContactId, { [Data.MIMETYPE]: MimeType.PHOTO, [Data.DATA14]: fileId, [Data.DATA15]: 'thumbnail' });
  }

  insertGroup(accountName: string, title: string): number {
    const id = this.fake.allocId();
    this.fake.table('groups').set(id, {
      ...defaults(GROUP_DEFAULTS),
      [Groups.TITLE]: title,
      [Groups.DIRTY]: 1,
      account_name: accountName,
      account_type: this.fake.accountType,
    });
    return id;
  }

  updateGroup(groupId: number, values: Row): void {
    const g = this.fake.table('groups').get(groupId);
    if (!g) throw new Error(`no group ${groupId}`);
    Object.assign(g, values, { [Groups.DIRTY]: 1 });
    g[Groups.VERSION] = Number(g[Groups.VERSION] ?? 1) + 1;
  }

  /** App delete: memberships go at once, the group stays DELETED=1 until purged. */
  deleteGroup(groupId: number): void {
    for (const [id, row] of [...this.fake.table('data')]) {
      if (row[Data.MIMETYPE] === MimeType.GROUP_MEMBERSHIP && Number(row[Data.DATA1]) === groupId) {
        this.fake.table('data').delete(id);
        this.fake.bumpVersion(Number(row[Data.RAW_CONTACT_ID]));
      }
    }
    const g = this.fake.table('groups').get(groupId);
    if (g) Object.assign(g, { [Groups.DELETED]: 1, [Groups.DIRTY]: 1 });
  }

  /** Fossify deletes groups through a sync-adapter URI: gone at once, no DELETED marker. */
  fossifyDeleteGroup(groupId: number): void {
    this.fake.deleteRow('groups', groupId);
  }

  addToGroup(rawContactId: number, groupId: number): number {
    return this.insertData(rawContactId, { [Data.MIMETYPE]: MimeType.GROUP_MEMBERSHIP, [Data.DATA1]: groupId });
  }

  // ── calendar ───────────────────────────────────────────

  private event(id: number): StoredRow {
    const e = this.fake.table('events').get(id);
    if (!e) throw new Error(`no event ${id}`);
    return e;
  }

  /** A new event from a calendar app: no _SYNC_ID, DIRTY=1, organizer defaults to the owner. */
  insertEvent(calendarId: number, values: Row, children: { attendees?: Row[]; reminders?: Row[] } = {}): number {
    const calendar = this.fake.table('calendars').get(calendarId);
    if (!calendar) throw new Error(`no calendar ${calendarId}`);
    const id = this.fake.allocId();
    const row: StoredRow = { ...defaults(EVENT_DEFAULTS), ...values, [Events.CALENDAR_ID]: calendarId };
    this.fake.fixEvent(row, true);
    if (isEmpty(row[Events.ORGANIZER])) row[Events.ORGANIZER] = calendar[Calendars.OWNER_ACCOUNT];
    this.fake.table('events').set(id, row);
    if (!isEmpty(row[Events.ORIGINAL_SYNC_ID]) && isEmpty(row[Events.ORIGINAL_ID])) {
      for (const [mid, m] of this.fake.table('events')) {
        if (mid !== id && m[Events._SYNC_ID] === row[Events.ORIGINAL_SYNC_ID]) row[Events.ORIGINAL_ID] = mid;
      }
    }
    for (const a of children.attendees ?? []) this.fake.table('attendees').set(this.fake.allocId(), { ...a, event_id: id });
    for (const r of children.reminders ?? []) this.fake.table('reminders').set(this.fake.allocId(), { ...r, event_id: id });
    this.fake.markEventDirty(id);
    return id;
  }

  updateEvent(eventId: number, values: Row): void {
    const e = this.event(eventId);
    if (Events.STATUS in values && values[Events.STATUS] === null) throw new Error('NullPointerException: eventStatus');
    Object.assign(e, values);
    this.fake.fixEvent(e, false);
    this.fake.markEventDirty(eventId);
  }

  /**
   * App delete: without _SYNC_ID the row (and its un-synced exceptions) is
   * gone at once; with one it becomes DELETED=1, DIRTY=1, its reminders and
   * extended properties go at once, un-synced exceptions are hard-deleted and
   * synced exceptions stay.
   */
  deleteEvent(eventId: number): void {
    const e = this.event(eventId);
    const syncId = e[Events._SYNC_ID];
    const exceptionsOf = () =>
      [...this.fake.table('events')].filter(([, x]) => Number(x[Events.ORIGINAL_ID]) === eventId);
    if (isEmpty(syncId)) {
      for (const [xid] of exceptionsOf()) this.fake.deleteRow('events', xid);
      this.fake.deleteRow('events', eventId);
      return;
    }
    for (const [xid, x] of exceptionsOf()) if (isEmpty(x[Events._SYNC_ID])) this.fake.deleteRow('events', xid);
    for (const child of ['reminders', 'extended_properties'] as const) {
      for (const [cid, c] of [...this.fake.table(child)]) if (c.event_id === eventId) this.fake.table(child).delete(cid);
    }
    e[Events.DELETED] = 1;
    this.fake.markEventDirty(eventId);
  }

  /** Etar "this event" edit: a new row with ORIGINAL_SYNC_ID and ORIGINAL_INSTANCE_TIME (no UID_2445). */
  insertException(masterId: number, originalInstanceTime: number, values: Row): number {
    const m = this.event(masterId);
    return this.insertEvent(Number(m[Events.CALENDAR_ID]), {
      [Events.TITLE]: m[Events.TITLE],
      [Events.EVENT_TIMEZONE]: m[Events.EVENT_TIMEZONE],
      [Events.ALL_DAY]: m[Events.ALL_DAY],
      [Events.STATUS]: m[Events.STATUS],
      ...values,
      [Events.ORIGINAL_SYNC_ID]: m[Events._SYNC_ID],
      [Events.ORIGINAL_ID]: masterId,
      [Events.ORIGINAL_INSTANCE_TIME]: originalInstanceTime,
      [Events.ORIGINAL_ALL_DAY]: m[Events.ALL_DAY],
    });
  }

  /** Etar/Fossify "delete this event": a cancelled exception row, no EXDATE. */
  cancelInstance(masterId: number, originalInstanceTime: number, instanceEnd: number): number {
    return this.insertException(masterId, originalInstanceTime, {
      [Events.STATUS]: 2,
      [Events.DTSTART]: originalInstanceTime,
      [Events.DTEND]: instanceEnd,
    });
  }

  /**
   * CONTENT_EXCEPTION_URI without RRULE: clones the master except _SYNC_ID and
   * SYNC_DATA*, copies attendees and reminders, marks only the exception dirty.
   */
  exceptionViaUri(masterId: number, originalInstanceTime: number, values: Row): number {
    const m = this.event(masterId);
    const clone: StoredRow = { ...m };
    for (const c of [Events._SYNC_ID, Events.SYNC_DATA1, Events.SYNC_DATA2, Events.SYNC_DATA3, Events.SYNC_DATA4, Events.SYNC_DATA5, Events.SYNC_DATA6]) clone[c] = null;
    for (const c of [Events.RRULE, Events.RDATE, Events.EXRULE, Events.EXDATE]) clone[c] = null;
    const duration = String(m[Events.DURATION] ?? 'P0S');
    const secs = Number(/(\d+)S$/.exec(duration)?.[1] ?? 0) + Number(/(\d+)D$/.exec(duration)?.[1] ?? 0) * 86_400;
    Object.assign(clone, {
      [Events.DTSTART]: originalInstanceTime,
      [Events.DTEND]: originalInstanceTime + secs * 1000,
      [Events.DURATION]: null,
      ...values,
      [Events.ORIGINAL_ID]: masterId,
      [Events.ORIGINAL_SYNC_ID]: m[Events._SYNC_ID],
      [Events.ORIGINAL_INSTANCE_TIME]: originalInstanceTime,
      [Events.ORIGINAL_ALL_DAY]: m[Events.ALL_DAY],
      [Events.DIRTY]: 1,
      [Events.DELETED]: 0,
    });
    delete clone[Events.SELF_ATTENDEE_STATUS];
    const id = this.fake.allocId();
    this.fake.table('events').set(id, clone);
    for (const child of ['attendees', 'reminders'] as const) {
      for (const c of [...this.fake.table(child).values()]) {
        if (c.event_id === masterId) this.fake.table(child).set(this.fake.allocId(), { ...c, event_id: id });
      }
    }
    const self = values[Events.SELF_ATTENDEE_STATUS];
    if (!isEmpty(self)) {
      const owner = this.fake.table('calendars').get(Number(m[Events.CALENDAR_ID]))?.[Calendars.OWNER_ACCOUNT];
      const mine = [...this.fake.table('attendees').values()].filter((a) => a.event_id === id && a[Attendees.ATTENDEE_EMAIL] === owner);
      if (mine.length !== 1) throw new Error('Status update WTF');
      mine[0][Attendees.ATTENDEE_STATUS] = self;
    }
    this.fake.markEventDirty(id);
    return id;
  }

  /**
   * CONTENT_EXCEPTION_URI with an RRULE ("this and following" split by a third
   * party): the master's rule gets UNTIL without DIRTY, and a clone INCLUDING
   * _SYNC_ID, SYNC_DATA* and UID_2445 is inserted.
   */
  splitViaUri(masterId: number, splitAt: number, untilUtc: string, values: Row): number {
    const m = this.event(masterId);
    m[Events.RRULE] = `${String(m[Events.RRULE]).replace(/;?(UNTIL|COUNT)=[^;]*/g, '')};UNTIL=${untilUtc}`;
    const id = this.fake.allocId();
    this.fake.table('events').set(id, { ...m, [Events.DTSTART]: splitAt, ...values, [Events.DIRTY]: 1 });
    this.fake.markEventDirty(id);
    return id;
  }

  /** Etar RSVP "all events": the attendee row's status, event DIRTY. */
  setAttendeeStatus(eventId: number, email: string, status: number): void {
    for (const a of this.fake.table('attendees').values()) {
      if (a.event_id === eventId && a[Attendees.ATTENDEE_EMAIL] === email) a[Attendees.ATTENDEE_STATUS] = status;
    }
    this.fake.markEventDirty(eventId);
  }

  addAttendee(eventId: number, values: Row): number {
    const id = this.fake.allocId();
    this.fake.table('attendees').set(id, { ...values, event_id: eventId });
    this.fake.markEventDirty(eventId);
    return id;
  }

  removeAttendee(attendeeId: number): void {
    const a = this.fake.table('attendees').get(attendeeId);
    if (!a) return;
    this.fake.table('attendees').delete(attendeeId);
    this.fake.markEventDirty(Number(a.event_id));
  }

  setReminders(eventId: number, reminders: Array<{ minutes: number; method?: number }>): void {
    for (const [id, r] of [...this.fake.table('reminders')]) if (r.event_id === eventId) this.fake.table('reminders').delete(id);
    for (const r of reminders) {
      this.fake.table('reminders').set(this.fake.allocId(), {
        event_id: eventId,
        [Reminders.MINUTES]: r.minutes,
        [Reminders.METHOD]: r.method ?? 1,
      });
    }
    this.fake.markEventDirty(eventId);
  }

  /** Fossify Calendar's save: the event row updated, attendees and reminders deleted and re-inserted. */
  fossifySaveEvent(eventId: number, values: Row, attendees: Row[], reminders: Array<{ minutes: number; method?: number }>): void {
    this.updateEvent(eventId, values);
    for (const [id, a] of [...this.fake.table('attendees')]) if (a.event_id === eventId) this.fake.table('attendees').delete(id);
    for (const a of attendees) this.fake.table('attendees').set(this.fake.allocId(), { ...a, event_id: eventId });
    this.setReminders(eventId, reminders);
  }
}
