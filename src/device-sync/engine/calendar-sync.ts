/**
 * Calendars: server calendars ↔ Calendars rows, events ↔ Events rows with
 * their exceptions, attendees and reminders (docs/device-sync.md, "Calendar
 * mapping"). Tasks never sync; a calendar that holds only tasks gets no row.
 */
import { findTasksOnlyCalendarIds, isTaskLikeObject, SCAN_PROPERTIES, type ScannedCalendarObject } from '../../lib/calendar-component-detection';
import { collectionKey, parseCollectionKey, parseObjectRef, pendingUidOf } from '../common/ids';
import type { CalendarContext, CalendarEventWire, CalendarLike, CalendarPlanner, LocalCalendar, LocalEvent, OpGroup } from '../planner';
import { CALENDAR_AUTHORITY, type ReminderOwner, type Row } from '../types';
import { CALENDAR_EVENT_PROPERTIES, CALENDAR_PROPERTIES } from '../wire';
import { calendarAddresses, type CalendarAddresses, type CapabilityAccount } from '../jmap/session';
import type { Work } from './batch';
import type { RunEnv } from './context';
import type { SubscriptionCalendar } from './deps';
import { ItemSync, type Pending } from './item-sync';
import { accountOfRef, idInAccount, refOf, type Held, type Kind, type ServerObject } from './kinds';
import { poisonFingerprint } from './poison';
import { flag, num, str } from './provider';
import { isCollectionSelected } from './selection';
import { accountOf, type SyncState } from './sync-state';

const MASTER = 'original_id IS NULL AND original_sync_id IS NULL';
const WITH_IDENTITY = "_sync_id IS NOT NULL AND _sync_id NOT LIKE '~pending/%'";
/** CalendarProvider leaves DIRTY (and may leave DELETED) NULL on sync-adapter inserts: NULL is clean. */
const CLEAN = '(dirty IS NULL OR dirty = 0) AND (deleted IS NULL OR deleted = 0)';

function onIds(map: Record<string, boolean> | undefined | null): string[] {
  return Object.entries(map ?? {})
    .filter(([, on]) => on === true)
    .map(([id]) => id);
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

export class CalendarSync extends ItemSync {
  protected readonly itemType = 'CalendarEvent' as const;
  protected readonly itemProperties = CALENDAR_EVENT_PROPERTIES;
  protected readonly parentFilter = 'inCalendar' as const;
  protected readonly parentProperty = 'calendarIds' as const;

  readonly eventKind: Kind<LocalEvent, CalendarEventWire>;
  private readonly planner: CalendarPlanner;
  private readonly calendarColumns: string[];
  private readonly eventColumns: string[];
  private readonly attendeeColumns: string[];
  private readonly reminderColumns: string[];

  private readonly calendars = new Map<string, CalendarLike[]>();
  private readonly syncedKeys = new Set<string>();
  private readonly readOnlyKeys = new Set<string>();
  private readonly rowByKey = new Map<string, number>();
  private readonly keyByRow = new Map<number, string>();
  /** Calendar rows of deselected calendars: dropped after the upload. */
  private deleteRows: number[] = [];
  /** Per account: calendars found to hold only tasks (true) or events again (false). */
  private readonly taskOnlyNotes = new Map<string, Map<string, boolean>>();
  private readonly collectionStates = new Map<string, string>();
  private addresses: CalendarAddresses = { ownerAccount: '', selfAddresses: [] };
  private subscriptions: SubscriptionCalendar[] = [];
  private zone = 'UTC';
  /** Who the Reminders rows of this run are written for (the stored owner until the owner-change pass). */
  private reminderOwner: ReminderOwner = 'device';

  constructor(env: RunEnv) {
    super(env);
    this.planner = env.deps.planners.calendar;
    this.calendarColumns = union(this.planner.calendarColumns, ['_id']);
    this.eventColumns = union(this.planner.eventColumns, ['_id', 'calendar_id', '_sync_id', 'original_id', 'original_sync_id']);
    this.attendeeColumns = union(this.planner.attendeeColumns, ['_id', 'event_id']);
    this.reminderColumns = union(this.planner.reminderColumns, ['_id', 'event_id']);
    this.eventKind = this.makeEventKind();
  }

  // ── Kind ──

  private makeEventKind(): Kind<LocalEvent, CalendarEventWire> {
    const planner = this.planner;
    return {
      name: 'event',
      table: 'events',
      identityColumn: '_sync_id',
      poisonColumn: 'sync_data5',
      meta: (e) => {
        const identity = parseObjectRef(e.syncId) ? e.syncId : null;
        const pendingUid = pendingUidOf(e.syncId);
        const calendarKey = this.keyByRow.get(e.calendarRowId) ?? null;
        const acct = accountOfRef(identity) ?? accountOfRef(calendarKey);
        return {
          rowId: e.eventId,
          // A split clone shares its source's _SYNC_ID but uploads as a new event.
          sourceId: e.split === 'clone' ? null : identity,
          pending: e.pending ?? (pendingUid && calendarKey ? { uid: pendingUid, target: calendarKey } : null),
          dirty: e.dirty || e.split !== undefined || e.exceptions.some((x) => x.dirty || x.deleted),
          deleted: e.deleted,
          isNew: !identity || e.split === 'clone',
          poison: e.poison,
          collections: e.shadow && acct
            ? onIds(e.shadow.calendarIds as Record<string, boolean>).map((id) => collectionKey(acct, id))
            : calendarKey ? [calendarKey] : [],
        };
      },
      fingerprint: (e) =>
        poisonFingerprint({
          deleted: e.deleted,
          shadow: e.shadow,
          cells: e.cells,
          attendees: e.attendees.map((a) => JSON.stringify(a.cells)).sort(),
          reminders: e.reminders.map((r) => JSON.stringify(r.cells)).sort(),
          exceptions: e.exceptions
            .map((x) => JSON.stringify([x.deleted, x.cells, x.attendees.map((a) => a.cells), x.reminders.map((r) => r.cells)]))
            .sort(),
        }),
      loadByRefs: async (refs) => {
        const out = new Map<string, LocalEvent>();
        for (const e of await this.loadMastersIn('_sync_id', refs)) {
          if (e.split !== 'clone' && e.syncId && parseObjectRef(e.syncId)) out.set(e.syncId, e);
        }
        return out;
      },
      loadByRowIds: (ids) => this.loadMastersIn('_id', ids),
      loadNew: () => this.loadMastersWhere("_sync_id IS NULL OR _sync_id LIKE '~pending/%'"),
      planDownload: (event, local, acct) => planner.planDownload(event, local, this.ctx(acct)),
      planLocalDelete: (e) => planner.planLocalDelete(e),
      planBaselineHeal: (e) => planner.planBaselineHeal(e),
      planUpload: (e, acct) => planner.planUpload(e, this.ctx(acct)),
      planAccepted: (e, event, acct) => planner.planAccepted(e, event, this.ctx(acct)),
    };
  }

  protected kinds(): Kind[] {
    return [this.eventKind];
  }

  /** Tasks never sync (explicit `@type: "Task"`, or CalDAV VTODOs recognised by their task-only fields). */
  protected kindOf(object: ServerObject): Kind | null {
    return isTaskLikeObject(object as ScannedCalendarObject) ? null : this.eventKind;
  }

  // ── Loading ──

  private async decodeWithExceptions(masters: Row[]): Promise<LocalEvent[]> {
    if (!masters.length) return [];
    const byId = new Map<number, Row>();
    for (const row of masters) byId.set(num(row._id), row);
    const ids = masters.map((r) => num(r._id));
    const syncIds = masters.map((r) => str(r._sync_id)).filter((s): s is string => !!s);
    for (const row of await this.env.reader.rowsIn('events', this.eventColumns, 'original_id', ids)) byId.set(num(row._id), row);
    if (syncIds.length) {
      for (const row of await this.env.reader.rowsIn('events', this.eventColumns, 'original_sync_id', syncIds)) byId.set(num(row._id), row);
    }
    const all = [...byId.values()];
    const eventIds = all.map((r) => num(r._id));
    const attendees = await this.env.reader.rowsIn('attendees', this.attendeeColumns, 'event_id', eventIds);
    const reminders = await this.env.reader.rowsIn('reminders', this.reminderColumns, 'event_id', eventIds);
    return this.planner.decodeEvents(all, attendees, reminders);
  }

  private async loadMastersIn(column: '_id' | '_sync_id', values: ReadonlyArray<string | number>): Promise<LocalEvent[]> {
    if (!values.length) return [];
    return this.decodeWithExceptions(await this.env.reader.rowsIn('events', this.eventColumns, column, values, { where: MASTER }));
  }

  private async loadMastersWhere(where: string, args: Array<string | number> = []): Promise<LocalEvent[]> {
    return this.decodeWithExceptions(await this.env.reader.rows('events', this.eventColumns, `(${where}) AND ${MASTER}`, args));
  }

  private async masterIds(where: string, args: Array<string | number> = []): Promise<number[]> {
    return (await this.env.reader.rows('events', ['_id'], `(${where}) AND ${MASTER}`, args)).map((r) => num(r._id));
  }

  private async loadCalendars(): Promise<LocalCalendar[]> {
    return (await this.env.reader.rows('calendars', this.calendarColumns)).map((r) => this.planner.decodeCalendar(r));
  }

  private async refreshCalendarRows(): Promise<void> {
    this.rowByKey.clear();
    this.keyByRow.clear();
    for (const calendar of await this.loadCalendars()) {
      if (!calendar.syncId || !parseCollectionKey(calendar.syncId)) continue;
      this.rowByKey.set(calendar.syncId, calendar.calendarRowId);
      this.keyByRow.set(calendar.calendarRowId, calendar.syncId);
    }
  }

  // ── Collections ──

  private isFeed(account: CapabilityAccount, calendarId: string): boolean {
    return this.subscriptions.some(
      (s) => s.calendarId === calendarId && (s.jmapAccountId === account.id || (s.jmapAccountId === null && account.primary)),
    );
  }

  private noteTaskOnly(acct: string, calendarId: string, taskOnly: boolean): void {
    let notes = this.taskOnlyNotes.get(acct);
    if (!notes) this.taskOnlyNotes.set(acct, (notes = new Map()));
    notes.set(calendarId, taskOnly);
  }

  private isTaskOnly(acct: string, calendarId: string): boolean {
    return this.taskOnlyNotes.get(acct)?.get(calendarId) ?? (this.env.store.account(acct).taskOnly ?? []).includes(calendarId);
  }

  /** A calendar whose first objects are all tasks (Stalwart offers no per-calendar component set). */
  private async scanTaskOnly(acct: string, calendarId: string): Promise<boolean> {
    const ids = await this.env.jmap.queryFirst('CalendarEvent', acct, { inCalendar: calendarId }, this.env.tuning.taskScanLimit);
    if (!ids.length) return false;
    const { list } = await this.env.jmap.get<ScannedCalendarObject>('CalendarEvent', acct, ids, SCAN_PROPERTIES);
    return findTasksOnlyCalendarIds(list.map((o) => ({ ...o, calendarIds: { [calendarId]: true } })), [calendarId]).has(calendarId);
  }

  protected async collections(write: boolean): Promise<void> {
    this.zone = this.env.deps.deviceZone();
    this.reminderOwner = this.env.store.committed.reminderOwner ?? this.env.prefs.reminderOwner;
    this.addresses = await calendarAddresses(this.env.jmap, this.env.accountName);
    this.subscriptions = await this.env.deps.subscriptionCalendars();
    this.syncedKeys.clear();
    this.readOnlyKeys.clear();
    const selected: Array<{ jmapAccountId: string; calendar: CalendarLike; readOnly: boolean; accountName: string }> = [];
    for (const account of this.env.accounts) {
      const containers = await this.containersOf<CalendarLike>('Calendar', account.id, CALENDAR_PROPERTIES);
      if (!containers) continue;
      const { list, state } = containers;
      this.calendars.set(account.id, list);
      if (state) {
        this.collectionStates.set(account.id, state);
        this.env.recordKnownState(account.id, 'Calendar', state);
      }
      const stored = this.env.store.account(account.id);
      const reconciling = !stored.itemsState || !!stored.reconcile;
      for (const calendar of list) {
        if (calendar.myRights?.mayReadItems === false) continue;
        if (!isCollectionSelected(this.env.prefs.calendarSelection, account, CALENDAR_AUTHORITY, calendar)) continue;
        const key = collectionKey(account.id, calendar.id);
        // Checked when a calendar comes to the device, and again on every full reconcile.
        if (write && (reconciling || (!stored.selected.includes(key) && !this.isTaskOnly(account.id, calendar.id)))) {
          this.noteTaskOnly(account.id, calendar.id, await this.scanTaskOnly(account.id, calendar.id));
        }
        if (this.isTaskOnly(account.id, calendar.id)) continue;
        const rights = calendar.myRights;
        const readOnly = this.isFeed(account, calendar.id) || (!!rights && !rights.mayWriteAll && !rights.mayWriteOwn);
        this.syncedKeys.add(key);
        if (readOnly) this.readOnlyKeys.add(key);
        selected.push({ jmapAccountId: account.id, calendar, readOnly, accountName: account.personal ? '' : account.name });
      }
    }
    await this.refreshCalendarRows();
    this.deleteRows = [];
    if (!write) return;
    const plan = this.planner.planCalendars(selected, await this.loadCalendars(), this.calendarCtx());
    await this.env.writer.write(plan.groups.map((group) => ({ group })));
    this.deleteRows = plan.deleteCalendarRows;
    await this.refreshCalendarRows();
  }

  protected syncedCollections(acct: string): string[] {
    return (this.calendars.get(acct) ?? [])
      .filter((c) => this.syncedKeys.has(collectionKey(acct, c.id)))
      .map((c) => c.id);
  }

  protected inSelection(acct: string, object: ServerObject): boolean {
    return onIds(object.calendarIds as Record<string, boolean>).some((id) => this.syncedKeys.has(collectionKey(acct, id)));
  }

  private findCalendar(calendarId: string): CalendarLike | undefined {
    for (const account of this.env.accounts) {
      const found = this.calendars.get(account.id)?.find((c) => c.id === calendarId);
      if (found) return found;
    }
    return undefined;
  }

  private calendarCtx(): Omit<CalendarContext, 'jmapAccountId'> {
    const env = this.env;
    const primary = this.env.accounts.find((a) => a.primary)?.id ?? this.env.accounts[0]?.id ?? '';
    return {
      now: env.now(),
      mintKey: (taken) => env.mintKey(taken),
      mintUid: () => env.mintUid(),
      deviceZone: this.zone,
      ownerAccount: this.addresses.ownerAccount,
      selfAddresses: this.addresses.selfAddresses,
      reminderOwner: this.reminderOwner,
      calendar: (calendarId) => this.findCalendar(calendarId),
      calendarRowId: (calendarId) => this.rowByKey.get(collectionKey(primary, calendarId)) ?? null,
      calendarIdOfRow: (rowId) => {
        const parsed = parseCollectionKey(this.keyByRow.get(rowId));
        return parsed ? { jmapAccountId: parsed.accountId, calendarId: parsed.id } : null;
      },
      isReadOnly: (calendarId) => [...this.readOnlyKeys].some((k) => parseCollectionKey(k)?.id === calendarId),
      isSelected: (key) => this.syncedKeys.has(key),
    };
  }

  ctx(acct: string): CalendarContext {
    return {
      ...this.calendarCtx(),
      jmapAccountId: acct,
      calendar: (calendarId) => this.calendars.get(acct)?.find((c) => c.id === calendarId),
      calendarRowId: (calendarId) => this.rowByKey.get(collectionKey(acct, calendarId)) ?? null,
      isReadOnly: (calendarId) => this.readOnlyKeys.has(collectionKey(acct, calendarId)),
    };
  }

  protected decorateState(acct: string, next: SyncState): () => void {
    const account = accountOf(next, acct);
    const notes = this.taskOnlyNotes.get(acct);
    const consumed = new Map(notes ?? []);
    if (consumed.size) {
      const taskOnly = new Set(account.taskOnly ?? []);
      for (const [id, only] of consumed) {
        if (only) taskOnly.add(id);
        else taskOnly.delete(id);
      }
      account.taskOnly = [...taskOnly];
    }
    const collections = this.collectionStates.get(acct);
    if (collections) account.collectionsState = collections;
    return () => {
      for (const [id, only] of consumed) if (notes?.get(id) === only) notes.delete(id);
    };
  }

  protected async localIdentities(acct: string): Promise<Map<string, { dirty: boolean; deleted: boolean }>> {
    const out = new Map<string, { dirty: boolean; deleted: boolean }>();
    const rows = await this.env.reader.rows('events', ['_id', '_sync_id', 'dirty', 'deleted'], `_sync_id LIKE ? AND ${MASTER}`, [`${acct}/%`]);
    for (const row of rows) {
      const id = idInAccount(str(row._sync_id), acct);
      if (id) out.set(id, { dirty: flag(row.dirty), deleted: flag(row.deleted) });
    }
    return out;
  }

  // ── Uploads ──

  /**
   * Masters with local changes: dirty, deleted or new ones, masters of dirty
   * or deleted exception rows, and both masters of a CONTENT_EXCEPTION_URI
   * split (two masters sharing a _SYNC_ID; the older one's rule changed
   * without DIRTY), loaded together so the planner sees the split.
   */
  protected async loadUploadItems(): Promise<Held[]> {
    const rows = await this.env.reader.rows(
      'events',
      ['_id', '_sync_id', 'original_id', 'original_sync_id', 'uid2445'],
      "dirty = 1 OR deleted = 1 OR _sync_id IS NULL OR _sync_id LIKE '~pending/%'",
    );
    const ids = new Set<number>();
    const refs = new Set<string>();
    const newUids = new Set<string>();
    for (const row of rows) {
      if (row.original_id !== null && row.original_id !== undefined) ids.add(num(row.original_id));
      else if (str(row.original_sync_id)) refs.add(str(row.original_sync_id) as string);
      else {
        ids.add(num(row._id));
        const uid = str(row.uid2445);
        if (uid && !parseObjectRef(str(row._sync_id))) newUids.add(uid);
      }
    }
    const bySyncId = new Map<string, number[]>();
    for (const row of await this.env.reader.rows('events', ['_id', '_sync_id'], `_sync_id IS NOT NULL AND ${MASTER}`)) {
      const syncId = str(row._sync_id) as string;
      bySyncId.set(syncId, [...(bySyncId.get(syncId) ?? []), num(row._id)]);
    }
    for (const [syncId, masters] of bySyncId) {
      if (masters.length > 1 || refs.has(syncId)) for (const id of masters) ids.add(id);
    }
    // A new master may carry a uid another row has (an app copied an event): those rows come along, so
    // the planner sees the collision and gives the new one a fresh uid instead of adopting the other's object.
    if (newUids.size) {
      for (const row of await this.env.reader.rowsIn('events', ['_id'], 'uid2445', [...newUids], { where: MASTER })) ids.add(num(row._id));
    }
    const events = await this.loadMastersIn('_id', [...ids]);
    return events.map((local) => ({ kind: this.eventKind as Kind, local }));
  }

  /** Event uids are unique per account: only an event in the create's calendar can be the row's own create. */
  protected adoptionTargetMatches(acct: string, object: ServerObject, target: string): boolean {
    const parsed = parseCollectionKey(target);
    return !!parsed && parsed.accountId === acct && (object.calendarIds as Record<string, boolean> | undefined)?.[parsed.id] === true;
  }

  protected accountOfItem(held: Held): string | null {
    return super.accountOfItem(held) ?? accountOfRef(this.keyByRow.get((held.local as LocalEvent).calendarRowId) ?? null);
  }

  protected claimAccount(held: Held): string | null {
    return accountOfRef(this.keyByRow.get((held.local as LocalEvent).calendarRowId) ?? null);
  }

  /** A split clone is claimed after its source's rule was planned (see prePhase). */
  protected claimable(held: Held): boolean {
    return (held.local as LocalEvent).split !== 'clone';
  }

  protected async countDeletions(items: Held[]): Promise<{ count: number; synced: number; accounts: Set<string> }> {
    let count = 0;
    const accounts = new Set<string>();
    for (const held of items) {
      const meta = held.kind.meta(held.local);
      if (!meta.deleted || !meta.sourceId) continue;
      count++;
      const acct = accountOfRef(meta.sourceId);
      if (acct) accounts.add(acct);
    }
    const synced = (await this.masterIds(WITH_IDENTITY)).length;
    return { count, synced: Math.max(synced, count), accounts };
  }

  /**
   * Before the creates: a split's source uploads its rule while the split is
   * still visible, then its clone is claimed as a new event; and deleted +
   * new masters of the run that are one edit (a move, a series turned
   * single) upload as patches of the existing object.
   */
  protected async prePhase(acct: string): Promise<void> {
    let items = (await this.loadUploadItems()).filter((h) => this.accountOfItem(h) === acct);
    const sources = items.filter((h) => (h.local as LocalEvent).split === 'source');
    const clones = items.filter((h) => (h.local as LocalEvent).split === 'clone');
    if (sources.length || clones.length) {
      const works: Work[] = [];
      const ready: Pending[] = [];
      for (const held of sources) {
        const pending = await this.planItem(acct, held, works);
        if (pending) ready.push(pending);
      }
      // A clone (of a split, or a new master whose uid another row carries) needs no source:
      // it claims a fresh uid here and is created with the other new events.
      for (const held of clones) {
        const pending = await this.planItem(acct, held, works);
        if (pending) ready.push(pending);
      }
      await this.env.writer.write(works);
      if (ready.length) await this.send(acct, ready);
      items = (await this.loadUploadItems()).filter((h) => this.accountOfItem(h) === acct);
    }
    const deleted = items.map((h) => h.local as LocalEvent).filter((e) => {
      const m = this.eventKind.meta(e);
      return m.deleted && !!m.sourceId;
    });
    const fresh = items.map((h) => h.local as LocalEvent).filter((e) => {
      const m = this.eventKind.meta(e);
      return m.isNew && !m.deleted && !!m.pending;
    });
    if (!deleted.length || !fresh.length) return;
    let pairs: ReturnType<CalendarPlanner['planPairs']>;
    try {
      pairs = this.planner.planPairs(deleted, fresh, this.ctx(acct));
    } catch (error) {
      // Unpaired, they upload as ordinary creates and deletions.
      this.plannerFailed(acct, `pairs:${acct}`, 'upload', error);
      return;
    }
    if (!pairs.length) return;
    await this.env.checkpoints.check('upload:pairs');
    const pending: Pending[] = pairs.map((pair) => {
      const meta = this.eventKind.meta(pair.deleted);
      const ownId = idInAccount(meta.sourceId, acct);
      return {
        held: { kind: this.eventKind, local: pair.deleted },
        meta,
        fingerprint: this.eventKind.fingerprint(pair.deleted),
        actions: pair.actions as Pending['actions'],
        accept: async (objects) => {
          // The new row takes the identity and exceptions of the old one, which is purged.
          await this.env.writer.write([{ group: pair.ops }]);
          const [moved] = await this.eventKind.loadByRowIds([pair.fresh.eventId]);
          const server = ownId ? objects.get(ownId) : undefined;
          if (!moved || !server) {
            if (ownId) this.markStale(acct, ownId);
            return [];
          }
          const held: Held = { kind: this.eventKind, local: moved };
          try {
            return [this.acceptWork(acct, { held, meta: this.eventKind.meta(moved), fingerprint: '', actions: [] }, server, false)];
          } catch (error) {
            this.plannerFailed(acct, refOf(acct, server.id), 'upload', error, server.id);
            return [];
          }
        },
      };
    });
    await this.send(acct, pending);
  }

  // ── After the upload ──

  /** A master with nothing waiting for an upload. */
  private isClean(e: LocalEvent): boolean {
    const m = this.eventKind.meta(e);
    return !m.dirty && !m.deleted && !m.isNew;
  }

  /**
   * Deselected calendars lose their rows (the provider deletes their events)
   * once nothing in them waits for an upload; until then only their clean
   * events go. Events that left every synced calendar go when clean.
   */
  protected async dropOutsideSelection(acct: string): Promise<void> {
    const synced = new Set(this.syncedCollections(acct).map((id) => collectionKey(acct, id)));
    const deselected = this.env.store.account(acct).selected.filter((key) => !synced.has(key));
    const rows = this.deleteRows.filter((row) => accountOfRef(this.keyByRow.get(row) ?? null) === acct);
    const outside = [...(this.outside.get(acct) ?? [])];
    if (!deselected.length && !rows.length && !outside.length) return;
    const kept = new Set<string>();
    for (const rowId of rows) {
      await this.env.checkpoints.check('deselect');
      const key = this.keyByRow.get(rowId) as string;
      if (await this.dropCalendarRow(rowId)) continue;
      kept.add(key);
    }
    const works: Work[] = [];
    for (const local of (await this.eventKind.loadByRefs(outside)).values()) {
      const meta = this.eventKind.meta(local);
      const id = idInAccount(meta.sourceId, acct);
      if (!id || !meta.collections.length || meta.collections.some((k) => synced.has(k))) continue;
      const work = this.removeWork(acct, id, { kind: this.eventKind, local }, 'outside');
      if (work) works.push(work);
    }
    const selected = [...synced, ...kept];
    await this.env.writer.write(works, this.tail([acct], (next) => {
      accountOf(next, acct).selected = selected;
    }));
    this.outside.delete(acct);
  }

  /** Deletes a calendar row when none of its events waits for an upload; else only its clean events. True when the row went. */
  private async dropCalendarRow(rowId: number): Promise<boolean> {
    const waiting = await this.env.reader.rows(
      'events',
      ['_id'],
      "calendar_id = ? AND (dirty = 1 OR deleted = 1 OR _sync_id IS NULL OR _sync_id LIKE '~pending/%')",
      [rowId],
    );
    if (!waiting.length) {
      await this.env.writer.write([{ group: { ref: `calendar:${rowId}`, ops: [{ op: 'delete', table: 'calendars', id: rowId }] } }]);
      return true;
    }
    const clean = await this.masterIds(`calendar_id = ? AND ${CLEAN} AND ${WITH_IDENTITY}`, [rowId]);
    for (let i = 0; i < clean.length; i += this.env.tuning.chunkSize) {
      await this.env.checkpoints.check('deselect');
      const works: Work[] = [];
      for (const local of await this.eventKind.loadByRowIds(clean.slice(i, i + this.env.tuning.chunkSize))) {
        const meta = this.eventKind.meta(local);
        const acct = accountOfRef(meta.sourceId);
        const id = acct ? idInAccount(meta.sourceId, acct) : null;
        if (!acct || !id || !this.isClean(local)) continue;
        const work = this.removeWork(acct, id, { kind: this.eventKind, local }, 'outside');
        if (work) works.push(work);
      }
      await this.env.writer.write(works);
    }
    return false;
  }

  protected async afterSync(): Promise<void> {
    // Rows of calendars that belong to no account we know (garbage, or a vanished account).
    for (const rowId of this.deleteRows) {
      if (this.keyByRow.has(rowId) && accountOfRef(this.keyByRow.get(rowId) ?? null)) continue;
      await this.dropCalendarRow(rowId);
    }
    await this.zonePass();
    await this.reminderOwnerPass();
  }

  /** Every clean master, in chunks, through `plan`; `finish` rides with the last chunk's batch. */
  private async passOverCleanMasters(
    label: string,
    plan: (e: LocalEvent, acct: string) => OpGroup | null,
    finish: (next: SyncState) => void,
  ): Promise<void> {
    const ids = await this.masterIds(`${CLEAN} AND ${WITH_IDENTITY}`);
    const size = this.env.tuning.chunkSize;
    if (!ids.length) {
      await this.env.writer.write([], this.env.store.tail(finish));
      return;
    }
    for (let i = 0; i < ids.length; i += size) {
      await this.env.checkpoints.check(label);
      const works: Work[] = [];
      for (const local of await this.eventKind.loadByRowIds(ids.slice(i, i + size))) {
        const sourceId = this.eventKind.meta(local).sourceId;
        const acct = accountOfRef(sourceId);
        if (!acct || !this.isClean(local)) continue;
        try {
          const group = plan(local, acct);
          // A group that fails its assert was edited meanwhile: the upload takes it from here.
          if (group) works.push({ group });
        } catch (error) {
          this.plannerFailed(acct, sourceId as string, 'download', error);
        }
      }
      await this.env.writer.write(works, i + size >= ids.length ? this.env.store.tail(finish) : undefined);
    }
  }

  /**
   * The device zone changed: clean floating events are rewritten so they
   * keep their wall time. `deviceZonePending` marks the pass until its last
   * chunk stores the new zone.
   */
  private async zonePass(): Promise<void> {
    const committed = this.env.store.committed;
    const stored = committed.deviceZone ?? null;
    if (!stored) {
      await this.env.writer.write([], this.env.store.tail((next) => {
        next.deviceZone = this.zone;
        next.deviceZonePending = null;
      }));
      return;
    }
    if (stored === this.zone && !committed.deviceZonePending) return;
    if (committed.deviceZonePending !== this.zone) {
      await this.env.writer.write([], this.env.store.tail((next) => {
        next.deviceZonePending = this.zone;
      }));
    }
    await this.passOverCleanMasters(
      'zone',
      (e, acct) => this.planner.planZoneChange(e, stored, this.ctx(acct)),
      (next) => {
        next.deviceZone = this.zone;
        next.deviceZonePending = null;
      },
    );
  }

  /**
   * The reminder owner changed (the run's uploads used the old one, so
   * pending reminder edits went up first): Reminders rows and baselines are
   * rewritten for the new owner, and the calendars' MAX_REMINDERS follows.
   */
  private async reminderOwnerPass(): Promise<void> {
    const stored = this.env.store.committed.reminderOwner ?? null;
    const wanted = this.env.prefs.reminderOwner;
    if (stored === wanted) return;
    this.reminderOwner = wanted;
    if (!stored) {
      // The first run wrote everything for the wanted owner already.
      await this.env.writer.write([], this.env.store.tail((next) => {
        next.reminderOwner = wanted;
      }));
      return;
    }
    await this.passOverCleanMasters(
      'reminders',
      (e, acct) => this.planner.planReminderOwnerChange(e, this.ctx(acct)),
      (next) => {
        next.reminderOwner = wanted;
      },
    );
    const selected: Array<{ jmapAccountId: string; calendar: CalendarLike; readOnly: boolean; accountName: string }> = [];
    for (const account of this.env.accounts) {
      for (const calendar of this.calendars.get(account.id) ?? []) {
        const key = collectionKey(account.id, calendar.id);
        if (!this.syncedKeys.has(key)) continue;
        selected.push({ jmapAccountId: account.id, calendar, readOnly: this.readOnlyKeys.has(key), accountName: account.personal ? '' : account.name });
      }
    }
    const plan = this.planner.planCalendars(selected, await this.loadCalendars(), this.calendarCtx());
    await this.env.writer.write(plan.groups.map((group) => ({ group })));
  }
}
