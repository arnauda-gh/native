# Device sync: contacts and calendars in Android's providers

Issue [#34](https://github.com/bulwarkmail/native/issues/34). Each signed-in
account can opt in to device sync. Its address books then appear in Android's
Contacts provider and its calendars in the Calendar provider, under an Android
account of type "Bulwark". Google Contacts and Calendar, AOSP/Fossify Contacts,
Etar, the dialer and Settings → Accounts all see them. Server changes reach the
device, and creates, edits and deletes made in any Android app reach the
server.

This document is for maintainers. It describes the design: the architecture,
what every provider column holds, the mapping tables, the merge rules, the
native API, the failure matrix and the known limitations. Behaviour it relies
on was checked against Stalwart v0.16.23 (the server Bulwark targets) and
AOSP's ContactsProvider, CalendarProvider and the calendar/contacts apps; the
notable findings are quoted where they shape a rule.

## Contents

1. [Architecture](#architecture)
2. [The Android shell](#the-android-shell)
3. [Device data model](#device-data-model)
4. [A sync run](#a-sync-run)
5. [Change detection and merge rules](#change-detection-and-merge-rules)
6. [Uploads](#uploads)
7. [Contacts mapping](#contacts-mapping)
8. [Calendar mapping](#calendar-mapping)
9. [Headless payload, report and SyncResult](#headless-payload-report-and-syncresult)
10. [Native module API](#native-module-api)
11. [App integration](#app-integration)
12. [Failure matrix](#failure-matrix)
13. [Limits and performance](#limits-and-performance)
14. [Testing](#testing)
15. [Decisions and limitations](#decisions-and-limitations)
16. [Out of scope](#out-of-scope)

## Architecture

The Android sync framework drives everything. Kotlin is a thin shell; the sync
engine is TypeScript that runs as a headless JS task and reaches the providers
through a native module.

```
SyncManager ──onPerformSync──▶ DeviceSyncAdapter (Kotlin, SyncAdapterThread)
                                 │ posts to the main thread: start React Native if needed,
                                 │ start headless task BulwarkDeviceSync {runId, …}
                                 │ waits on a latch (≤ 9.5 min, 2.5 min for expedited jobs)
                                 ▼
                        runDeviceSync (TypeScript, JS thread)
                          │ JMAP: a detached JMAPClient per registry account
                          │ provider: NativeModules.BulwarkDeviceSync (query / applyBatch)
                          ▼
                        finishRun(runId, report) ──▶ latch released ──▶ SyncResult
```

Why this split:

- Auth, token refresh, mTLS, 429 back-off and session discovery stay in the
  existing JS client (`src/api/jmap-client.ts`). Refresh tokens rotate; a
  second owner outside JS's de-duplication could evict the account.
- Mappers and merge rules are pure TypeScript with no React Native import, so
  vitest covers them with golden fixtures and property tests. A test walks the
  import graph of every module in `src/device-sync` except the React Native
  boundary (`native.ts`, `task.ts`, `jmap/client-port.ts` and `app/`) and
  fails on `react-native`, expo, stores or `jmap-client`: the global mocks in
  `src/test-setup.ts` would otherwise hide such an import.
- Kotlin only translates: URIs, `ContentProviderOperation`s, `SyncResult`. Its
  logic has JVM unit tests (`android/app/src/test`).

A pure-Kotlin engine was rejected: it would have to redeem rotating refresh
tokens outside JS's de-duplication, re-implement session discovery with its
origin rewrite, mTLS, 429 handling and the first-touch gate, read
expo-secure-store's internal format, and start from zero test infrastructure.

There is one ReactHost and one Hermes runtime per process. A sync that runs
while the UI is open runs in the UI's runtime (the task is started with
`allowedInForeground = true`), and a sync that cold-started the process leaves
its runtime for the UI to attach to. So the engine never touches the UI's
`jmapClient` singleton or zustand stores it does not own, and a module-level
mutex coordinates runs with app-side operations.

### Code map

| Path | What it holds |
|---|---|
| `android/app/src/main/java/com/anonymous/bulwarkmobile/HeadlessJs.kt` | starting React Native and a headless task; shared with the push job |
| `android/app/src/main/java/com/anonymous/bulwarkmobile/sync/` | authenticator, sync adapters, run registry, report mapping, native module, provider op translation, push router |
| `android/app/src/main/res/xml/{authenticator,sync_contacts,sync_calendar,contacts}.xml` | framework metadata |
| `android/app/src/debug/java/…/sync/DeviceSyncDebugReceiver.kt` | adb hooks for device tests (debug builds only) |
| `src/device-sync/types.ts`, `android-columns.ts` | contracts: bridge API, row model, ops, payload, report; provider column names |
| `src/device-sync/planner.ts`, `wire.ts` | the contract between the engine and the two planners; JMAP objects as Stalwart sends them |
| `src/device-sync/native.ts` | typed wrapper around `NativeModules.BulwarkDeviceSync` |
| `src/device-sync/common/` | pure helpers: identities and minted keys, canonical JSON, hashing, JSON Pointer patches |
| `src/device-sync/contacts/` | JSContact ↔ contacts rows, row matching, contact merge rules (pure) |
| `src/device-sync/calendar/` | JSCalendar ↔ calendar rows, RRULE, exceptions, zoned time, durations, merge rules (pure) |
| `src/device-sync/jmap/` | the JMAP side on a detached client: session accounts, `/get`, `/changes`, `/query` paging, `/set`, uid lookup, the auth rebuild |
| `src/device-sync/engine/` | orchestration: run entry, mutex, checkpoints, batches, SyncState, poison markers, default selection, teardown, report |
| `src/device-sync/task.ts` | the headless task entry (registered in `index.ts`) and the teardown the app calls |
| `src/device-sync/app/` | the app side: turning sync on and off, sign-out, reconciling Android's accounts, triggers, the chooser's collection list, the reminder filter |
| `src/stores/device-sync-store.ts` | per-account preferences and the last run status |
| `src/components/settings/device-sync/` | the "Sync to this device" sections, rendered by `ContactsSettings.tsx` and `CalendarSettings.tsx` |

## The Android shell

### Account type and accounts

The account type is `${applicationId}.account`, defined once in
`android/app/build.gradle` with `resValue` and referenced as
`@string/device_sync_account_type` from the XML and through
`R.string.device_sync_account_type` from Kotlin. The package name may change
before a store listing; nothing hard-codes it. The account label is "Bulwark"
and its icon is the app icon.

One Android account exists per registry account (`AccountEntry.id`,
`username@hostname`) that has device sync on for at least one authority. Its
name is the account's login; when two registry accounts share a login on
different servers, the second one is named after its registry id. The registry
id is stored in the account's `userData` under `registryId` and is the only
link back to the app: the name is for people. `GET_ACCOUNTS` is not needed:
an authenticator always sees its own accounts, and `addAccountExplicitly`
needs only a UID match on API 23+.

Other apps see the account (API 26+) when they hold `READ_CONTACTS` and we hold
a granted `WRITE_CONTACTS`; Contacts apps that list accounts rely on that.

### Authenticator

`BulwarkAuthenticator` and `BulwarkAuthenticatorService`:

- `addAccount` (Settings → Accounts → Add account) never creates an account
  without credentials. It returns an explicit Intent to MainActivity with
  `bulwarkmobile://settings/contacts`, where the user turns sync on. (The
  AccountManager only accepts an Intent that resolves inside our package.)
- `getAccountRemovalAllowed` allows removal. The providers then delete every
  row of the account and its SyncState; the app notices and turns device sync
  off for that account. It never recreates the account on its own.
- Everything else (`getAuthToken`, `confirmCredentials`, …) returns
  `ERROR_CODE_UNSUPPORTED_OPERATION`.

### Sync adapters

Two `AbstractThreadedSyncAdapter` services (`ContactsSyncService`,
`CalendarSyncService`), declared with `supportsUploading="true"`,
`userVisible="true"`, `allowParallelSyncs="false"`, and in the main process so
they share the ReactHost with the UI. The contacts service also declares
`android.provider.CONTACTS_STRUCTURE` → `xml/contacts.xml`, whose `EditSchema`
lists exactly the data kinds in the [contacts mapping](#contacts-mapping).
AOSP Contacts rejects the whole account type when that XML breaks its rules
(every typed kind needs `<Type>` children, `name` needs all six `supports*`
attributes, `photo` must be present, single-value kinds need `maxOccurs="1"`),
and without an EditSchema it treats the account as read-only.

Exported services are safe: `startSync`/`cancelSync` ignore callers other than
the system UID.

`onPerformSync` (see `DeviceSyncAdapter.kt`):

1. Reads `registryId` from the account's userData; a missing one is a hard
   error (`databaseError`).
2. Opens a run in `DeviceSyncRuns`: a random `runId`, a latch, a cancel flag.
   Headless task ids restart at 1 with every React context, so they never
   identify a run.
3. Posts to the main thread: `HeadlessJs.withReadyReactContext` starts React
   Native if needed (on the main thread only: the ReactHost is created lazily
   without a lock), then starts the headless task `BulwarkDeviceSync` with the
   [payload](#headless-payload-report-and-syncresult) and
   `allowedInForeground = true`. The task timeout is the adapter's deadline
   minus 20 s; the payload's `deadline` is 30 s earlier still.
4. Waits until the first of: `finishRun`, the headless task ending (JS settled
   without a report, timed out, or the context was reloaded), React refusing or
   failing to start (the boot task faults, e.g. a debug build without Metro),
   or the deadline: 9.5 minutes, or 2.5 minutes when the sync runs as an
   expedited job (`schedule_as_expedited_job`), inside JobScheduler's 10 and 3
   minute guarantees.
5. Maps the report onto `SyncResult`; no report is a soft error.

`onSyncCanceled` interrupts the sync thread; the run is closed, and JS sees
`isRunCancelled(runId) == true` (also for any run nobody waits for) at its next
checkpoint. A run ends once: `finishRun` is accepted only while the run is
still waiting, so a report that arrives after the deadline, a boot fault or the
task's end is refused rather than half-applied. SyncManager holds a wake lock for as
long as `onPerformSync` runs, so the adapter takes none.

SyncManager also cancels a sync that moves fewer than 10 bytes of network
traffic in any 60-second window. The engine sends a `Core/echo` when a local
phase has gone 40 s without a JMAP request.

### Spike results

Checked before building anything else on it, on the API 34 and API 32
emulators with the debug build (commit `ed2525e`):

| App state | Report received after |
|---|---|
| foreground (task runs next to the UI, `AppState` active) | 319-334 ms |
| background (process alive) | 320-327 ms |
| process killed (SyncManager starts it for the sync service; React starts headless, bundle from Metro) | 16.2 s (API 34), 8.5 s (API 32) |

An io report was retried with back-off, an auth report was not retried, too
many deletions showed the system's "Attempted to delete too many Contacts."
notification, and with Metro unreachable the adapter gave up after 2 s.
Found on the way: SyncManager retries a failed sync at once when it made
progress (`madeSomeProgress`), so hard errors are reported without progress;
and without the runtime permission `AbstractThreadedSyncAdapter` fails the sync
itself (`databaseError`) before `onPerformSync` runs, so the app must detect a
revoked permission on its own.

## Device data model

### Identity

| Row | Column | Value |
|---|---|---|
| raw contact | `RawContacts.SOURCE_ID` | `<jmapAccountId>/<cardId>`; null until created on the server |
| group | `Groups.SOURCE_ID` | `<jmapAccountId>/<cardId>` of a `kind: "group"` card |
| calendar | `Calendars._SYNC_ID` | `<jmapAccountId>/<calendarId>` |
| event (master or single) | `Events._SYNC_ID` | `<jmapAccountId>/<eventId>`, or `~pending/<uid>` for a local event claimed for upload |
| event exception | `Events._SYNC_ID` + `ORIGINAL_SYNC_ID` | `<jmapAccountId>/<eventId>#<recurrenceId>` + the master's `_SYNC_ID` |

JMAP ids use only `[A-Za-z0-9_-]` (RFC 8620 §1.2), so `/`, `#` and `~` never
occur in them: ids stay unique across the JMAP accounts, shared ones included,
that feed one Android account, and `~pending/…` can never be a server id.

Identities are only unique for one server account's lifetime (Stalwart's ids
come from small per-account counters). So the SyncState records which registry
account and server origin the rows belong to, a run refuses to touch rows
written for another one, and a merge treats a server object whose `uid`
differs from its shadow's as a different object (delete and insert, never a
patch).

Why a pending `_SYNC_ID`: CalendarProvider hard-deletes an app-deleted event
that has no `_SYNC_ID`, so a local event deleted while its create was in flight
would vanish without a trace and come back from the server. With a `_SYNC_ID`
the delete is a soft delete (`DELETED=1`) the engine can act on. It also lets
Etar create exceptions of a not-yet-uploaded series (it offers "this event" only
when the master has a `_SYNC_ID`); the provider rewrites their
`ORIGINAL_SYNC_ID` when the master's `_SYNC_ID` changes. Contacts need no such
marker: raw contacts of a sync account are always soft-deleted.

A **new** local item is a raw contact without `SOURCE_ID`, or a master event
(`ORIGINAL_ID` and `ORIGINAL_SYNC_ID` both null) whose `_SYNC_ID` is null or
pending, or the newer of two masters sharing a `_SYNC_ID` (a
`CONTENT_EXCEPTION_URI` split, see [Recurrence](#recurrence)). DIRTY is not
the test: a raw contact inserted without data rows is not dirty. A row with
`ORIGINAL_*` set is always an exception of its master and never uploads as an
event of its own.

### Contacts columns

| Column | Holds |
|---|---|
| `RawContacts.SOURCE_ID` | identity (above) |
| `RawContacts.SYNC1` | the card's selected address books: `<jmapAccountId>/<addressBookId>` joined by `,` |
| `RawContacts.SYNC2` | the shadow: the last server card, wire format, with each `data:` photo URI replaced by `sha256:<hex>` of its bytes, plus a `~memberOf` member: the group cards whose memberships the rows held after our last write, so a removal on the device and an addition on the server can be told apart (stripped before any projection or patch) |
| `RawContacts.SYNC3` | the pending create: `{"uid":…,"target":"<jmapAccountId>/<addressBookId>"}`, written before the `/set` and kept until the identity is |
| `RawContacts.SYNC4` | poison marker `{"fp":…,"type":…,"n":…,"until":…}` |
| `RawContacts.RAW_CONTACT_IS_READ_ONLY` | 1 when none of the card's address books grants `mayWrite`. Only written, and only along with other raw contact writes, so an echo stays write-free: ContactsProvider refuses the column in every projection and selection ("Invalid column", API 32 and 35). Whether device edits are put back is decided from the server's current rights on the stored card |
| `Data.DATA_SYNC1` | the entry key(s), e.g. `emails:work1`; see [units](#units) |
| `Data.DATA_SYNC2` | photo rows: the hash of the server photo applied to the row |
| `Data.DATA_SYNC3` | the baseline: the row's mapped columns as the provider stored them after our last write (JSON; text over 1 KB as its hash) |
| `Groups.SOURCE_ID`, `SYNC2`, `SYNC3`, `SYNC4` | as for raw contacts, for group cards; `GROUP_IS_READ_ONLY` is written like `RAW_CONTACT_IS_READ_ONLY`, for groups in read-only books (`SHOULD_SYNC` is never written: an update carrying it makes ContactsProvider request a sync) |
| `Settings` | one row per account: `UNGROUPED_VISIBLE=1`, `SHOULD_SYNC=1` (the default 0 hides every contact without a visible group) |

Writing `DIRTY=0`, `SOURCE_ID` or `SYNC1-4` does not bump
`RawContacts.VERSION`; data-row inserts, updates and deletes do, whoever makes
them. So VERSION is used only as an optimistic-lock token in asserts, and DIRTY
for change detection. (A super-primary change in another account can bump our
VERSION without DIRTY; the assert then fails once and the row is re-read.)

### Calendar columns

| Column | Holds |
|---|---|
| `Calendars._SYNC_ID` | identity |
| `Calendars.CAL_SYNC1` | unused: CalendarProvider sends it as the `feed` extra of the sync it requests whenever a calendar with `SYNC_EVENTS=1` is inserted or changed, so anything there splits those requests apart |
| `Calendars.CAL_SYNC2` | the shadow: the last server `Calendar` object |
| `Calendars.CAL_SYNC3` | flags JSON: the `readOnly` reason (`rights`, `subscription`) |
| `Events._SYNC_ID` | identity |
| `Events.SYNC_DATA1` | masters and single events: the shadow, the full server event with its `recurrenceOverrides` |
| `Events.SYNC_DATA2` | exceptions: the recurrence id, exactly as the server's override key |
| `Events.SYNC_DATA3` | the pending create: `{"uid":…,"target":"<jmapAccountId>/<calendarId>"}` |
| `Events.SYNC_DATA4` | the baseline: mapped event columns, attendees and reminders as stored after our last write (JSON; text over 1 KB as its hash) |
| `Events.SYNC_DATA5` | poison marker |
| `Events.UID_2445` | the event's `uid` |

Attendees and reminders have no sync columns, which is why their baseline sits
on the event row. `Events.MUTATORS` (the packages that changed the event since
our last write) tells which app made a device edit.

A description longer than 64 KB of UTF-8 is written truncated, marked in the
baseline, and never uploaded: an event row carries the description, the
shadow and the baseline, and one Binder transaction holds 1 MB.

### SyncState

`ContactsContract.SyncState` and `CalendarContract.SyncState` hold one blob per
Android account (CalendarProvider requires sync-adapter URIs for it): UTF-8
JSON, versioned.

```json
{
  "v": 1,
  "owner": { "registryId": "usera@example.org@mail.example.org", "origin": "https://mail.example.org" },
  "accounts": {
    "c": {
      "collectionsState": "s12eq",
      "itemsState": "syufa",
      "selected": ["c/b"],
      "stale": [],
      "reconcile": null,
      "groups": ["c/e12"],
      "taskOnly": []
    }
  },
  "deviceZone": "Europe/Berlin",
  "deviceZonePending": null,
  "reminderOwner": "device"
}
```

- `owner`: the registry account and the server origin the rows were written
  for. A run for another owner stops with `internal`, and a teardown uploads
  nothing for it; turning sync off and on again starts over.
- `itemsState` is the `ContactCard` or `CalendarEvent` state the rows describe.
  It is written in the same `applyBatch` as the last item group of a `/changes`
  page: the `syncState` op is the last op of that batch, is never
  `yieldAllowed`, and the native side refuses a batch that breaks either rule,
  so a provider yield can never commit the state ahead of its rows.
- No stored `itemsState` is newer than the shadow of an object changed before
  it: an object whose rows could not be written (a planner error, a provider
  refusal that re-planning did not fix) goes on `stale` in the same batch, is
  fetched again first in every run, and uploads nothing until it has been.
  The state still advances, so one bad object never blocks the pages after
  it.
- `reconcile` marks a full reconcile in progress: `{ "from": <state taken
  first>, "phase": "ids" | "objects", "position": n, "after": <id> }`,
  written with every chunk of objects. `after` is the last id processed in
  the reconcile's sorted order: the next run lists the ids again and
  continues after it (`phase` and `position` are informative only). `from:
  null` asks for a reconcile that has not started (after
  `cannotCalculateChanges`, or when local deletions were discarded). Its
  deletions are applied only when the complete id list is known, and
  `itemsState` becomes `from` when it ends.
- `selected` is the selection the rows were written for; a collection is added
  in the batch with its last loaded chunk, and removed with its last deleted
  row.
- `groups` (contacts): the group cards present on the device, so a group an app
  hard-deleted (Fossify does) is recognised by its absence.
- `taskOnly` lists calendars found to hold only tasks.
- `deviceZone` (calendar) is the zone floating events were written in;
  `deviceZonePending` is set while a zone-change pass runs and cleared, with
  `deviceZone` updated, in the batch of its last chunk.
- `reminderOwner` (calendar) is who the Reminders rows were written for
  (`device` or `bulwark`), so a run notices a changed choice; see
  [Reminder owner](#reminder-owner).
- The providers delete the row with the account. A teardown clears it by
  writing `''`.

## A sync run

One run handles one Android account and one authority. A module-level mutex per
(registry account, authority) serialises it with other runs and with app-side
operations such as turning sync off; a run that cannot get it before its
deadline reports `cancelled` with `moreRecordsToGet`.

1. **Preflight**, in this order:
   - The authority is still enabled for the Android account
     (`getSyncAutomatically`) → otherwise `disabled`.
   - The SyncState is read; without the runtime permission this first
     provider read fails with `permission`. A blob that cannot be understood
     (another version, garbage) counts as none: every JMAP account starts over
     with a full reconcile. Its `owner` must be this registry account (see
     [Identity](#identity)) → otherwise `internal`.
   - An upload-only sync (`extras.upload`) with nothing dirty, deleted or new
     for our account ends here with `ok`, before JMAP is opened:
     ContactsProvider and CalendarProvider schedule an upload sync for every
     account 30 s after any app write, other accounts' included. A pending
     reconcile or objects on `stale` make it a full run.
   - `new JMAPClient().loadAccount(registryId)`: `false` or
     `AuthenticationError` → rebuild once (another client may have rotated
     the refresh token); still failing → `auth`, plus one notification that
     deep-links to sign-in. Nothing local is touched. The SyncState's `owner`
     must also name this server's origin → otherwise `internal`.
   - The capability on at least one JMAP account → else `unsupported`.
2. **Collections.** `AddressBook/get` or `Calendar/get` (explicit properties)
   for the primary JMAP account of the capability (`primaryAccounts[capability]`)
   and every shared account that advertises it; calendar rows are inserted and
   updated to match. An account that refuses to list its collections
   (`forbidden`, `accountNotFound`, `accountNotSupportedByMethod`) is left out
   of the run: nothing downloads or uploads for it, its rows stay on the
   device untouched, and it is only logged, without an item error (Stalwart
   lists an account shared for mail only with every capability, and a
   refusal can pass). Newly selected collections are loaded after step 3 has
   brought the account up to date, restricted to them, so the stored state
   never skips changes of the other collections. Deselected collections are
   dropped in step 5.
3. **Download.**
   - Objects on `stale` are fetched again first.
   - With a stored `itemsState`: `/changes` with `maxChanges: 256` and a
     `hasMoreChanges` loop; each page's changed ids are fetched with explicit
     `properties` in batches of `maxObjectsInGet`.
   - Without a state, or on `cannotCalculateChanges`: a full reconcile,
     checkpointed in `reconcile` (see [SyncState](#syncstate)). The state is
     taken first (`/get` with `ids: []`), then every selected collection's ids
     (`/query`, `inAddressBook`/`inCalendar`, `limit` 5000 with `position`
     paging; pages overlap by up to 100 ids, so a deletion between two pages
     skips nothing), then the objects in batches. Rows without an identity or
     with a pending one (and exceptions of pending masters) are never
     reconcile deletions. A reconcile that finds zero remote objects while the
     device holds more than 10 rows for that JMAP account stops with
     `safetyAbort` instead of wiping the device.
   - Contacts: a page's group cards are written before its contacts. When a
     group card's `members` changed, its old and new member contacts are
     fetched in the same page, before the page's state op: their membership
     rows change although their own cards did not.
   - An object without rows first looks for a local item it may already be:
     a new row whose pending create targets a collection the object is in and
     whose pending uid is the object's `uid` (our own create whose identity
     never got written) is adopted: it takes the identity and shadow and is
     merged as a dirty item.
   - Each object is [merged](#merge-rules) into its rows. An object that left
     every selected collection loses its rows only when they are clean; dirty
     units are uploaded first.
   - An object whose rows could not be written (a planner error, a provider
     refusal that re-planning did not fix) goes on `stale`, and the page's
     state still advances.
   - Rows are written in chunks; the new state goes into the last chunk of each
     page, so every page is a checkpoint.
4. **Upload**, always after download so merges see the latest server truth; see
   [Uploads](#uploads).
5. **After the upload.** Deselected collections are dropped, and only their
   clean rows go: dirty items there were uploaded first (they are still valid
   objects on the server), and an item whose upload failed keeps its rows,
   and its collection stays in `selected`. Rows of objects that left every
   selected collection go the same way. Calendar: then the device-zone pass
   and the reminder-owner pass rewrite clean events (see [Timing](#timing)
   and [Reminder owner](#reminder-owner)).
6. **Report** counts, conflicts, per-item errors and duration; persist the
   status for the settings UI; call `finishRun` before the task's promise
   settles (JS timers stop once the task is over).

`/get` always lists `properties` explicitly: with `properties: null` Stalwart
leaves out JMAP-only fields such as `useDefaultAlerts`, and `ids: null` returns
at most 500 objects without saying so (only collections, of which Stalwart
allows 250 per account, are read with `ids: null`).

Checkpoints sit between chunks and phases. At each one the run checks
`isRunCancelled` (and whether a teardown asked it to stop), its deadline and
the time since the last JMAP request. Less than 30 s before the deadline it
stops cleanly and reports `moreRecordsToGet`, which the adapter turns into
`fullSyncRequested` (SyncManager ignores `moreRecordsToGet` itself). The step
from a create's `/set` to its identity write is not interruptible, and a
create batch starts only while at least two request timeouts (60 s) of budget
remain before the deadline (`deadlineMarginMs` and `createBudgetMs` in
`DEFAULT_TUNING`, `engine/deps.ts`). An expedited sync gets 2.5 minutes, of
which the adapter keeps 50 s in reserve; when it first has to start React
Native, little of the rest is left in which a create batch may start.

Failures stay contained. A planner that throws on one item affects only that
item: a download puts the object on `stale`, an upload skips the item and
reports it as `plannerError`. An account-level refusal of a whole `/set` holds
back only that account (see [Uploads](#uploads)).

### Invariants

Every reviewer checks against these.

1. **No server data loss.** Uploads are JMAP patches (RFC 8620 §5.3, JSON
   Pointer with `~0`/`~1` escaping) computed per mapped property against the
   baseline. A property Android can't represent is never sent. A full-object
   replace is never sent, and neither is a destroy + create for what was an
   edit or a move on the device. Where Stalwart needs a whole map resent
   (deleting a map entry, adding the first entry), the map is rebuilt from the
   fresh shadow, so its other entries go back unchanged, and the request carries
   `ifInState` so it cannot overwrite a server change the merge did not see.
   What an editor did not model (a row it re-inserted without some column, an
   entry it dropped) is never read as a deletion.
2. **No silent device-edit loss.** A dirty row is cleared only after the server
   accepted the change, and only if it wasn't edited again during the upload:
   the clearing batch asserts `RawContacts.VERSION` for contacts and the full
   read projection (event row, attendees, reminders) for events, so check and
   clear are one provider transaction. A row whose mapped projection equals its
   baseline (only STARRED changed, say) is cleared without uploading. No dirty,
   deleted or pending row is removed locally (deselection, move-away, disable,
   logout, account reconciliation) before its upload succeeded or the user
   confirmed losing it.
3. **Crash-safe and idempotent.** Every step can be re-run. The JMAP state is
   written in the same `applyBatch` as the last chunk of rows it describes, as
   that batch's last op. Creates carry a client-minted `uid`, written to the
   row with the create's target before the `/set`; a download adopts a pending
   row by uid, and an upload looks the uid up and adopts what it finds in the
   create's target collection, so a retry never duplicates on either side.
4. **No feedback loops.** Adapter writes use `CALLER_IS_SYNCADAPTER`, which
   neither sets DIRTY nor schedules an upload sync, and never touch the
   columns that make a provider request a sync (`CAL_SYNC1`, `Groups.SHOULD_SYNC`).
   An echo of our own upload compares equal to the shadow and results in zero
   provider writes. A run that failed reports progress only for rows it
   actually wrote.
5. **Scoped.** Only rows of our own account type are read or written; the
   native side enforces it for every table.
6. **Deletion safety.** Local→server deletions above the threshold set
   `tooManyDeletions`; `SYNC_EXTRAS_OVERRIDE_TOO_MANY_DELETIONS` and
   `SYNC_EXTRAS_DISCARD_LOCAL_DELETIONS` are honoured. Deletions inferred from
   absence (groups) count toward the threshold. A full reconcile that returns
   zero remote objects while the device holds more than 10 aborts. Deleting a
   device item that belongs to several collections removes only the selected
   memberships.
7. **Conflicts.** See [merge rules](#merge-rules).
8. **Limits respected:** `maxObjectsInGet/Set`, `maxCallsInRequest`, one
   request in flight per run, `/changes` paging, provider batch sizes and
   yield points, the Binder budget, the headless timeout and the JS thread
   (yield between chunks).
9. **iOS untouched.** Everything is gated by `Platform.OS === 'android'` plus
   the presence of the native module.
10. **No state ahead of a shadow.** No stored `itemsState` is newer than the
    shadow of an object that changed before it (see `stale`).

## Change detection and merge rules

### Baselines

Mappings are lossy in both directions, and the providers normalise what they
store: ContactsProvider splits a lone display name into components and fills a
missing formatted address, CalendarProvider fills the organizer, zeroes
all-day times and rewrites durations. Comparing rows against a fresh
`toDevice(shadow)` would see edits nobody made.

So every row carries a **baseline**: its mapped columns exactly as the provider
stored them after our last write, read back after each chunk (text over 1 KB
as its hash). A column that differs from its baseline was written by someone
else. A clean row's baseline is by definition its current content, so whenever
the engine reads a clean row whose baseline differs, it rewrites the baseline;
that also heals the crash window between a chunk and its read-back. Two
exceptions:

- the read-back also reads DIRTY (and VERSION): a row that turned dirty in the
  meantime keeps its old baseline, so the user's edit still counts;
- `timing` and `rule` of a recurring master are never healed, and the rows of
  a split are not healed at all: a `CONTENT_EXCEPTION_URI` split changes them
  without DIRTY (see [Recurrence](#recurrence)).

### Units

Changes are detected, merged and uploaded per **unit**:

- contacts: the name (the StructuredName row), each entry of a map (one data
  row: `emails:work1`, `phones:p-a`, `addresses:home`, …), the note, the
  photo, and the card's group memberships;
- events: groups of related columns (`title`, `description`, `location`,
  `timing`, `rule`, `status`, `availability`, `privacy`, `color`, `calendar`),
  each attendee (by email), the reminder set, each EXDATE and each exception
  row (recursively, the same units).

A unit's upload is the set of patch paths for the sub-fields whose columns
changed against the baseline; sub-fields Android can't hold are never in it.

### Row matching (contacts)

Row keys are hints, not identity. Fossify Contacts deletes and re-inserts every
data row but the name on each save, dropping `DATA_SYNC*`, the columns it does
not model (DEPARTMENT, labels, a website's type), `IS_PRIMARY`, and every
nickname and organization but one; AOSP Contacts updates rows in place. So,
per data kind:

1. Empty rows (an editor's blank nickname or note) are ignored.
2. Rows whose `DATA_SYNC1` key is in the shadow keep that key.
3. Rows without a usable key are matched to the shadow's unmatched entries by
   the kind's primary value (email address case-insensitively, phone digits,
   URL, date + type, …); then, only when the numbers of unmatched rows and
   entries are equal, pairwise in order.
4. Rows still unmatched are new entries and get fresh keys: `b` + 8 random
   base36 characters (Stalwart parses numeric keys as array indexes and
   generates `k<n>` itself, so neither is used).
5. Shadow entries still without a row count as deleted on the device **only
   when the kind still has rows matched by their key** (an in-place editor
   removed one), or when the kind has no row left at all and some other kind
   that re-inserting editors rewrite still has rows matched by their key (the
   editor worked in place: AOSP deleting a contact's only email, note or
   birthday). When every row of the kind is keyless, an editor rewrote them
   all, and a missing entry may just be one it could not show: it stays on the
   server. A missing name row is never a deletion; a missing photo row always
   is (no editor re-inserts photo rows).

A row matched by its key is compared column by column with its baseline; an
emptied column is a real deletion. A row matched by value has no baseline: its
primary value uploads when it differs from the shadow's projection, its TYPE
and LABEL only for phones, emails, addresses and events (editors that re-insert
rows write a constant type for websites), and never `IS_PRIMARY`; an empty
column never clears anything.

A merge into a dirty contact never gives keys to a kind whose rows are all
keyless: a keyed row there would later make the entries the editor could not
show look deleted. Every write that leaves a contact clean (a download into a
clean contact, an accepted upload, an upload with nothing to send, a revert)
makes its rows match the card: rows are rewritten, re-inserted or deleted, not
just given new baselines. Otherwise an entry Fossify could not show (a second
nickname) would read as deleted at the next in-place edit; it also puts back a
department Fossify dropped.

The name: `""` and NULL are the same. `name/full` uploads when DISPLAY_NAME
changed against the baseline and is not simply the provider's join of the
current components (a typed display name); when only components changed,
`name/full` is re-derived with them only if the shadow's `full` was the derived
one (Stalwart never re-derives it), and left alone when it was custom
("Müller, Hans").

### Lossy calendar editors

`Events.MUTATORS` names the app that changed the event. Fossify Calendar
re-inserts every attendee as a required attendee and rebuilds the RRULE from its
own model (FREQ, INTERVAL, COUNT or UNTIL, one BYDAY or BYMONTHDAY=-1,
BYMONTH). For an event it changed, attendee type and relationship changes are
ignored, and a rule change is applied part by part onto the shadow's rule: parts
Fossify models and changed are patched, parts it dropped stay.

### Key reconciliation (downloads)

Stalwart keeps the keys a JMAP client wrote. Cards and events written over
CardDAV/CalDAV, or received as invitations, have no stored keys, and Stalwart
generates them on every read: `k1…kN` by position for card entries and alerts,
`uuid5` of the address/name/URL for participants, locations and links. Such
keys shift when an entry is inserted before them. So before merging a new
server version, the engine maps the shadow's keys to the new keys by content
(equal entries first, then equal primary values) and renames the rows' keys;
only the remainder counts as added or removed. The first JMAP write to such an
object freezes its keys.

### Merge rules

For a dirty row whose object also changed on the server (base = shadow,
local = rows, remote = new server object), per unit:

| Local changed? | Remote changed? | Result |
|---|---|---|
| no | no | nothing |
| no | yes | write remote, new baseline |
| yes | no | keep local, still dirty; uploads later against the new shadow |
| yes | yes, to the same value | converged; new baseline |
| yes | yes, differently | **server wins**: write remote, new baseline, `conflicts += 1` |

"Remote changed" compares the mapped projection of base and remote, so a server
change to a sub-field Android doesn't show is not a conflict: the upload
patches only the paths the user changed and the server keeps its own.

Whole-object rules:

- Edit on the device + delete on the server → **the server delete wins**; the
  rows are deleted and counted as a conflict.
- Delete on the device + edit on the server → **the device delete wins**; the
  object is destroyed. A deletion is an explicit act; restoring the object
  would resurrect something the user removed.
- Delete on both → purge, no conflict.
- A server object whose `uid` differs from the shadow's is a different object:
  its rows are replaced, never patched.

Every download write into an existing item is guarded: the group asserts the
DIRTY flag and VERSION (contacts) or projection (events) the plan was made from,
and ops that address one row by id expect exactly one row. Exception rows are
deleted by id only. A failed assert re-reads and re-plans the item (up to 3
times); after that the item goes on `stale`.

## Uploads

The upload runs phase by phase across the JMAP accounts: new rows are claimed
(below), each account resolves its series splits and pairs, then every
account's creates go up, then every account's updates, then every account's
deletions, then (contacts) groups deleted by absence and group memberships. So
a move between accounts never destroys before it created. Changes go in `/set`
calls of at most `maxObjectsInSet` objects (creates: 50) and about 1 MB of
JSON (Stalwart splits bigger calls into several commits, which can apply
partially), one request in flight, and one `sendSchedulingMessages` value per
call (it is a request-level flag).

- **ifInState.** Every `/set` carries `ifInState` = the item state the merge
  was based on (then the `newState` of our previous `/set`). A `stateMismatch`
  (or Stalwart's `serverUnavailable`, a concurrent write that failed the whole
  call) means the server changed since the download: the run downloads that
  account again and repeats the phase. When `/changes` from the stored state
  then shows nothing new, the next `/set` uses the type's current state
  instead: Stalwart can name one point of its history two ways (a `/changes`
  state `s…` against the type's state `n` before the first item change), and
  `ifInState` compares them as text. After three retries the run reports `io`
  without progress (SyncManager would otherwise retry at once, without
  back-off).
- **Account refusals.** A method error on a whole `/set` that concerns the
  account (`accountReadOnly`, `forbidden`, `accountNotFound`,
  `accountNotSupportedByMethod`) holds back only that account: its items wait,
  the report lists the account, and the other accounts go on.
- **Splits.** A `CONTENT_EXCEPTION_URI` split (two masters sharing a
  `_SYNC_ID`, see [Recurrence](#recurrence)) is resolved first: the older
  master's capped rule is planned while the split is still visible, the newer
  row is claimed as a new event, then the rule is sent. The new event is
  created with the other creates.
- **Pairs.** Some apps turn an edit into a delete plus an insert: Etar moves an
  event to another calendar that way, and turns a recurring series into a
  single event (or edits "this and following" from its first instance) the
  same way. A deleted row and a new row of the same run whose projections
  match apart from the calendar (or the rule) are uploaded as a patch of the
  existing object (`calendarIds` swapped; `recurrenceRule: null` with its
  overrides removed); the new row takes the identity and exceptions of the old
  one, which is purged. Rows of different JMAP accounts never pair: that move
  is a create in the target account, identity written, and later in the run a
  destroy in the source, whose echo finds no rows left to change. Unpaired
  rows are ordinary creates and deletions.
- **New rows** (see [Identity](#identity) for what counts as new):
  1. Claim: write the pending create (`SYNC3` / `SYNC_DATA3`: the uid and the
     target collection; for events also `UID_2445` and
     `_SYNC_ID = ~pending/<uid>`). A row keeps a uid it already carries unless
     another row, synced or pending, uses the same uid (a
     `CONTENT_EXCEPTION_URI` split clones `UID_2445`, an app's "duplicate"
     copies it): then it gets a fresh one, and the engine loads every master
     that shares a new master's `UID_2445` so the planner sees the collision.
     A server object with that uid does not count, because it may be this
     row's own earlier create. The target is fixed at the claim: contacts go
     to the address book chosen in the settings if it is selected and
     writable, else to the personal account's default book (or its first by
     sort order) among the selected writable ones; with none, the item is
     skipped and reported as `noWritableAddressBook` in every run. Events go
     to the calendar of their row.
  2. Look the uid up: contacts in the target address book (card uids are
     unique per book), events in the whole account (event uids are unique per
     account). A hit in the create's target collection is adopted: the row
     takes its identity and is merged as a dirty item. A hit elsewhere (an
     event with the same uid in another calendar) is not this row's create,
     and adopting it would overwrite an unrelated event: the item is poisoned
     as `uidConflict`.
  3. Otherwise `create`.
  4. `invalidProperties` on `uid` means the object exists: Stalwart's
     duplicate check is synchronous but the `uid` query reads an asynchronous
     search index, so a just-created object can be invisible to the query. The
     card error names the existing id; for events the lookup is retried with
     back-off and, failing that, left to the next run's download, which adopts
     the row by uid.
  5. From the `/set` to the identity write nothing is interruptible, and a
     create batch starts only with at least two request timeouts (60 s) of
     budget left.
- **Exception rows** (`ORIGINAL_*` set) upload only as
  `recurrenceOverrides/<key>` of their master; those of a new master go up
  inside its create.
- **Dirty rows**: the patch from the changed units. An empty patch clears
  DIRTY without a request.
- **Deleted rows** (`DELETED=1`): an object that belongs to several
  collections loses only the selected memberships (`addressBookIds/<id>: null`
  / `calendarIds/<id>: null`) and is destroyed only when none would remain.
  Then the rows are purged with sync-adapter deletes (for events also their
  exceptions, by id: a sync-adapter delete removes only the row itself).
  `notFound` counts as done. A deleted row without identity but with a pending
  create is looked up first and destroyed if found.
- **Afterwards**: a `/get` of every touched id (a separate request for creates:
  Stalwart does not resolve result references to `/set`). The result becomes
  the new shadow, and the rows' baselines are refreshed from it, in one group
  per item that first asserts the VERSION/projection read before the upload,
  clears DIRTY and clears a poison marker the item carried. If the assert
  fails (edited again meanwhile), the shadow and identity are still written,
  the baselines of the uploaded units are set to the values that were
  uploaded, and DIRTY stays: the newer edit uploads next time, and so does a
  revert to the old value. For contacts these baseline writes address their
  data rows with `where _id = ?`, so a row deleted meanwhile does not fail the
  group.
- **SetErrors**:
  - `notFound` on update → treated as a remote delete (the rows go); on a
    destroy it counts as done; on a create the item is poisoned;
  - `forbidden` in a call that asked for scheduling messages → the item is
    retried once without them and the report notes "invitations not sent"
    (Stalwart refuses scheduling when it is disabled, when the account has no
    calendar address, or without the scheduling permission). `forbidden`
    otherwise: on a create the item is poisoned (a revert would delete the
    user's new item); on an update or a deletion the object is read-only on
    the server after all, and its rows are rewritten from the server's
    current version, fetched for it (the shadow holds photos only as hashes),
    or removed when the object is gone or outside the selection;
  - `stateMismatch` → as above;
  - `invalidProperties` on `uid` → as above;
  - `invalidProperties`, `invalidPatch`, `tooLarge`, `overQuota` and the rest →
    the item is poisoned.
- **Poison markers.** The engine writes the marker (`SYNC4` / `SYNC_DATA5`,
  `{"fp":…,"type":…,"n":…,"until":…}`): `fp` is a fingerprint of what the
  item uploads from (its flags, shadow and mapped rows; for events also the
  attendees, reminders and exception rows), `until` the end of a back-off of
  1 h that doubles up to 24 h while the item stays the same. The engine checks
  the marker before `planUpload`: until the back-off ends or the item
  changes, the item is skipped and the report lists it. The marker is cleared
  once an upload of the item is accepted. The planners check the same marker
  with the same fingerprint content, a duplicate of the engine's check.

### Deletion threshold

More than 50 local deletions of an authority in one run, and more than 20 % of
that authority's synced objects, set `tooManyDeletions` unless the run carries
`overrideTooManyDeletions`. Deletions inferred from absence (groups) count.
No deletion of that run is uploaded; everything else proceeds. With
`discardLocalDeletions` (the user chose "undo" in Android's too-many-deletions
notification), the affected JMAP accounts first get a `reconcile` marker in a
batch of its own, then the deleted rows are purged, so the next runs download
the objects again whatever their extras; a crash in between only asks the
question again. A teardown applies the same threshold: deletions above it stay
on the device and count as waiting changes, so the app asks before turning
sync off (see [Lifecycle](#lifecycle)).

## Contacts mapping

JSContact (RFC 9553) as Stalwart stores it, to ContactsContract. Anything not
listed is preserved through patching. Data rows are written with both the
display name and the components (the provider recomputes whichever is missing),
and every entry row stores its key(s) in `DATA_SYNC1`. Text is cut to what
ContactsProvider keeps (10 KiB; phone numbers 1000 characters), and a column
that was cut never uploads.

### Name (StructuredName, one row, key `name`)

| JSContact | Android |
|---|---|
| `name.full` | `DISPLAY_NAME`; when absent, `deriveFullName(components)` is written and `full` is not uploaded unless the user changes it |
| component `title` (also `prefix`) | `PREFIX` |
| component `given` | `GIVEN_NAME` |
| component `given2` (also `middle`, `additional`) | `MIDDLE_NAME` |
| component `surname` (+ `surname2`, joined with a space) | `FAMILY_NAME` |
| component `generation`, `credential` (also `suffix`) | `SUFFIX` |
| component `phonetic` of given / given2 / surname | `PHONETIC_GIVEN_NAME` / `PHONETIC_MIDDLE_NAME` / `PHONETIC_FAMILY_NAME` |

Upload: a changed column replaces the matching components (the first of their
kind; `surname2` is dropped only when `FAMILY_NAME` changed), keeps every other
component (separators, repeats, unknown kinds) in place, and sends the whole
`name/components` array (JSON Pointer can't address array elements). When
`name/full` goes along is in [row matching](#row-matching-contacts): a typed
display name uploads; a recomputed one re-derives `full` only when the server's
was derived too. A name the server holds without components uploads whole:
the components from the row and `full` = the display name, so retyping "Ada"
as "Ada King" on the device sends both.

### Entries

| JSContact | Android kind | Columns |
|---|---|---|
| `nicknames/<k>` | Nickname | `NAME`, `TYPE=DEFAULT` |
| `emails/<k>` | Email | `ADDRESS`; `TYPE` from contexts: `private`→HOME, `work`→WORK, none→OTHER, `label`→CUSTOM+`LABEL`; `pref=1`→`IS_PRIMARY` |
| `phones/<k>` | Phone | `NUMBER`; `TYPE` from features + contexts (table below); `label`→CUSTOM+`LABEL`; `pref=1`→`IS_PRIMARY` |
| `addresses/<k>` | StructuredPostal | components → `STREET`, `POBOX`, `NEIGHBORHOOD`, `CITY`, `REGION`, `POSTCODE`, `COUNTRY` (table below), `full`→`FORMATTED_ADDRESS` (a card without `full` gets a one-line address joined from the components, so the provider leaves the row as written); contexts → TYPE HOME/WORK/OTHER, `label`→CUSTOM |
| `organizations/<k>` + `titles` pointing at it | Organization | `name`→`COMPANY`, `units` joined with `, `→`DEPARTMENT`, title with `kind: title`→`TITLE`, title with `kind: role`→`JOB_DESCRIPTION`; key `organizations:<k>|titles:<t>,<r>`; titles without an organization get their own row |
| `links/<k>` | Website | `URL` ← `uri`; contexts `private`→HOME, `work`→WORK, else OTHER; `label`→CUSTOM |
| `anniversaries/<k>` | Event | `START_DATE`: `YYYY-MM-DD`, `--MM-DD` without year (`partialDateToString`); kind `birth`→BIRTHDAY, `wedding`→ANNIVERSARY, `other`→OTHER, anything else → CUSTOM + its kind as `LABEL`; a custom type uploads its label, lowercased, as the kind |
| `relatedTo/<uri>` | Relation | `NAME` ← the key (a `urn:uuid:` of a synced card shows that card's name), `TYPE` from the relation set (table below) |
| first entry of `notes` | Note | `NOTE` ← `note` |
| first `media` entry with `kind: "photo"` | Photo | full-size bytes into `PHOTO`; the provider scales them, stores the display photo and sets `PHOTO_FILE_ID` |
| group cards (`kind: "group"`) | Groups | `TITLE` ← `name.full`; `GROUP_VISIBLE=1`; `members` keys are uids of the member cards |
| membership | GroupMembership | one row per group card whose `members` holds this card's `uid`, written with `GROUP_ROW_ID` (`data1`, the group's row id); `GROUP_SOURCE_ID` is only read |

Phone types (first match wins; reverse: the table read right to left, and
`TYPE_OTHER` → no features):

| Features / contexts | `Phone.TYPE` |
|---|---|
| mobile + work | WORK_MOBILE |
| mobile | MOBILE (read: also `cell`) |
| fax + work | FAX_WORK |
| fax + private | FAX_HOME |
| fax | OTHER_FAX |
| pager + work | WORK_PAGER |
| pager | PAGER |
| textphone | TTY_TDD |
| main-number | MAIN |
| work (voice) | WORK |
| private (voice) | HOME |
| anything else | OTHER |

Postal components (reverse: an edited field replaces all components it was
built from with one component of the first kind, keeps the rest):

| Android | JSContact component kinds, joined in order |
|---|---|
| `STREET` | `name` (street), `number`, `building`, `floor`, `apartment`, `room`, `block`, `direction`, `landmark` (with `separator`s) |
| `POBOX` | `postOfficeBox` |
| `NEIGHBORHOOD` | `district`, `subdistrict` |
| `CITY` | `locality` |
| `REGION` | `region` |
| `POSTCODE` | `postcode` |
| `COUNTRY` | `country` |

Legacy flat address fields (`street`, `locality`, …) are read when there are no
components and never written. When an editor wrote only the formatted address
and the provider copied it into `STREET`, only `full` uploads.

Relations: `friend`↔FRIEND, `spouse`↔SPOUSE, `child`↔CHILD, `parent`↔PARENT,
`sibling`→RELATIVE, `kin`→RELATIVE, `co-worker`/`colleague`→CUSTOM with the
type as label, `agent`→ASSISTANT, `emergency`→CUSTOM. Device types without an
RFC 9553 equivalent (BROTHER, SISTER, MOTHER, FATHER, MANAGER, ASSISTANT,
DOMESTIC_PARTNER, PARTNER, REFERRED_BY) upload as the nearest RFC type
(`sibling`, `parent`, `colleague`, `agent`, `spouse`, `spouse`, `contact`) and are
only sent when the user changed the type. RELATIVE uploads as `kin`; a custom
type uploads its label, lowercased, as the relation type. Only a row matched by
its key can rename a relation (`relatedTo` is keyed by its value, so another
name is another entry): a re-inserted row showing another name may just show a
related card that was renamed since.

For emails, phones, addresses and websites, changing only the label of a custom
type uploads only `label`; the contexts the entry had stay.

Deleting an entry resends its whole map (Stalwart turns `map/key: null` into a
valueless vCard line or, for `relatedTo`, ignores it). Only `addresses`,
`members` and `keywords` take a `null` delete cleanly.

Preserve-only (never written, never uploaded): `speakToAs`,
`preferredLanguages`, `cryptoKeys`, `directories`, `calendars`,
`schedulingAddresses`, `onlineServices`, `keywords`, `personalInfo`,
`localizations`, `language`, notes after the first, media other than the
first photo, and `kind` (an `org` card syncs like a person; `group` cards are
groups). Device-only columns (STARRED, custom ringtone, send-to-voicemail,
`IS_SUPER_PRIMARY`) never upload.

Photos: a `data:` URI is decoded; a blob-backed `media` entry is downloaded
with the detached client. Upload: the display photo is read back, scaled to at
most 512 px, JPEG, and sent as a `data:image/jpeg;base64,…` URI in
`media/<key>/uri`, matching the app's picker. `DATA_SYNC2` holds the hash of
the server photo last applied, the baseline holds `PHOTO_FILE_ID`; a new file
id means the user changed the photo. Photos travel in batches of their own
(Binder budget). A photo whose bytes could not be fetched keeps its row and
counts as unchanged.

Groups: group cards are written before the contacts of the same download, and
membership rows name their group by row id (`GROUP_ROW_ID`, looked up by the
group's `SOURCE_ID`), never by `GROUP_SOURCE_ID`: a membership naming an
unknown `GROUP_SOURCE_ID` makes the provider create an empty group. A
membership whose group has no row is not written. A contact's memberships are
merged from three sets: what the rows held after our last write (`~memberOf`
in the shadow), the rows now, and the group cards that list the card's uid
now; both sides can only flip a membership the same way, so memberships never
conflict. Membership edits upload after the deletions, as patches of the
group cards' `members` (`members/<uid>: true` or `null`; the whole map for a
group without members). A contact stays dirty until the server's group cards
show its membership edits (the clean and accepted writes keep DIRTY); the
next run's clean write clears it.

A group deleted on the device is found by `DELETED`, or by its absence from the
rows while `SyncState.groups` still lists it (Fossify hard-deletes groups
through a sync-adapter URI); both count toward the deletion threshold.

## Calendar mapping

### Calendar rows

| JMAP `Calendar` | Android `Calendars` |
|---|---|
| `id` | `_SYNC_ID` = `<jmapAccountId>/<id>` |
| `name` | `NAME`, `CALENDAR_DISPLAY_NAME`; a shared account's calendars show `<name> (<account name>)` (the JMAP account's name, unless it is one of the user's addresses), the personal account's get no suffix |
| `color` | `CALENDAR_COLOR` (CSS color → ARGB; absent → the app's default palette colour) |
| `myRights` | `CALENDAR_ACCESS_LEVEL`: `mayWriteAll` → OWNER (700); `mayWriteOwn` → CONTRIBUTOR (500); `mayRSVP` → RESPOND (300); else READ (200); subscribed iCal feed → READ |
| the user's calendar address | `OWNER_ACCOUNT` (never null: Etar crashes on it) |
| `timeZone` | `CALENDAR_TIME_ZONE` (device zone when null) |
| — | `SYNC_EVENTS=1` (the default 0 hides every instance; written again when an app turns it off), `VISIBLE=1` on insert only (local afterwards), `ALLOWED_REMINDERS="1,2"`, `ALLOWED_AVAILABILITY="0,1"`, `ALLOWED_ATTENDEE_TYPES="0,1,2,3"`, `MAX_REMINDERS=5` (0 when Bulwark owns reminders), `CAN_ORGANIZER_RESPOND=0`, `CAN_PARTIALLY_UPDATE=0` |

Not synced: the virtual birthday calendar (client-side only), calendars
without `mayReadItems`, and task-only calendars: a calendar whose first 50
objects are all `@type: "Task"` (`isTaskLikeObject`), re-checked on each full
reconcile.

Deleting a calendar row deletes its events (provider trigger); the engine
first uploads the calendar's dirty events.

A read-only calendar (without `mayWriteAll` and `mayWriteOwn`, or a subscribed
feed) takes no device changes: a dirty event is rewritten from its shadow, a
deleted one is purged and fetched again, a new one is removed. The one
exception is the user's own RSVP on the master
(`participants/<id>/participationStatus`), which uploads when the calendar
grants `mayRSVP`. Edits of an event Stalwart holds only as an instance (no
series) are reverted too, in any calendar.

### Timing

| JSCalendar | Android |
|---|---|
| timed, `timeZone` set | `DTSTART` = instant of `start` in `timeZone`; `EVENT_TIMEZONE` = `timeZone` |
| floating (`timeZone` absent) | as timed, in the device zone; `SyncState.deviceZone` records it. When the device zone changes, clean floating events are rewritten so they keep their wall time |
| `showWithoutTime` | `ALL_DAY=1`, `DTSTART` = UTC midnight of the date, `EVENT_TIMEZONE="UTC"` |
| non-recurring | `DTEND` = start + `duration` (days nominal in the zone, the rest exact); `DURATION` null |
| recurring | `DURATION` = `P<n>D` (all-day) or `P<seconds>S` (timed), `DTEND` null |
| exception row | `DTEND` (the provider drops `DURATION` from exceptions) |

Android's Duration parser takes `[+-]P` then `<digits><W|D|H|M|S>` (with `M` always
minutes, no fractions, no `Y`); all-day durations must be `P<n>D` or the
provider throws. Server durations are parsed in full (weeks included, `P1W`
comes from CalDAV DTEND). All-day events are at least one day long on the
device: a duration with a time part is rounded up to whole days, a zero one
becomes one day, and neither is uploaded unless the timing changes.

Upload of timing: only when a timing column differs from the baseline. The
local start is recomputed in the event's zone (floating events stay floating,
all-day events stay dates), and the duration from DTEND/DURATION with whole days
nominal. `EVENT_TIMEZONE` must be an IANA id: an unknown id silently becomes GMT
on Android, and makes the event floating on Stalwart; zones are validated with
`Intl` before either write.

**DST edges.** Stalwart silently drops a `start`, an `until` or an override key
whose local time falls in a DST gap or overlap of the zone. Checked on the local
server: an event created at `2026-10-25T02:30` or `2026-03-29T02:30`
Europe/Berlin comes back without `start` and `timeZone`, and a daily rule with
`until: 2026-10-25T02:30` comes back without `until`, i.e. unbounded. So before
an upload:

- a local time in a gap moves forward by the gap (RFC 5545 semantics);
- a non-recurring event whose start falls in an overlap is sent in the
  fixed-offset zone of its instant (`Etc/GMT-2` for 02:30 CEST; `Etc/UTC` when
  the offset is not a whole hour): same instant, same wall time, only the zone
  name changes;
- a recurring event whose start or an override key falls in an overlap is not
  uploaded: the item stays dirty and is reported as `dstAmbiguous`;
- an `until` in a gap or overlap moves one hour later (better than Stalwart
  dropping it and the series running forever).

### Recurrence

| JSCalendar | Android |
|---|---|
| `recurrenceRule` | `RRULE`: `FREQ`, `INTERVAL` (>1), `COUNT`, `UNTIL` (UTC `…Z` for timed events, `YYYYMMDD` for all-day), every `BY*` part, `BYSETPOS`, `WKST` (when not Monday) |
| `rscale` other than gregorian, `skip`, leap months (`byMonth` with `L`) | not representable: the rule is written without them, the event's timing and rule are never uploaded, and an item whose only changes are to them is reported as `ruleNotRepresentable` |
| `excludedRecurrenceRule` | not supported by Stalwart; an `EXRULE` written by a device app is ignored |
| override `{excluded: true}` | `EXDATE`: comma list of UTC `YYYYMMDDTHHMMSSZ`, or `YYYYMMDD` for all-day (no prefix means UTC) |
| any other override, including `{}` | an exception row: master ⊕ override (applied as a PatchObject); `ORIGINAL_SYNC_ID`, `ORIGINAL_INSTANCE_TIME` = the key's instant in the master's zone, `ORIGINAL_ALL_DAY`; `SYNC_DATA2` = the key |
| — | `RDATE` is never written |

Why no RDATE: an infinite rule plus RDATE cannot be inserted (the provider
tries to expand it to infinity), and RDATE-only events lose their DTSTART
instance. An exception row whose original instance the rule does not generate
simply shows as an extra event, which is what an extra JMAP instance is.

AOSP expands BYSETPOS only for monthly rules with BYDAY, and walks at most 2000
periods from DTSTART (a daily series older than about 5.5 years shows no
instances); both are listed under limitations.

Device-side changes map back as follows:

| On the device | Upload |
|---|---|
| exception row inserted (Etar "this event": `ORIGINAL_SYNC_ID` + `ORIGINAL_INSTANCE_TIME`, `DIRTY=1`) or edited | `recurrenceOverrides/<key>`; the key is `ORIGINAL_INSTANCE_TIME` in the master's zone (a date at midnight for all-day). A new override carries the master's title, locations, participants and sequence (Stalwart stores a bare override as a separate event otherwise); an existing one is patched one level deep (`recurrenceOverrides/<key>/<property>`), never deeper: Stalwart turns a deeper pointer into a partial override (other attendees vanish for that instance) |
| exception row with `STATUS_CANCELED` (Etar and Fossify "delete this event"), a deleted exception row, or an EXDATE added to the master | `recurrenceOverrides/<key>: {excluded: true}` |
| EXDATE removed | `recurrenceOverrides/<key>: null` |
| master `RRULE` capped with `UNTIL`/`COUNT` + a new event without identity (Etar "this and following") | the master uploads only `recurrenceRule` (whole object) with the new `until`/`count` and removes the overrides after the new end (`recurrenceOverrides/<key>: null`; for a `COUNT` the end is the start of the last instance, CalendarProvider's `LAST_DATE` − `DURATION`); the new series is a row of its own, claimed and created as a new event with a fresh uid |
| master start moved (Etar "all events") | `start`/`duration`/`timeZone`, and every override key moved by the same local offset (overrides whose `start` equalled their old key move too), sent as the whole `recurrenceOverrides` map |
| two masters with the same `_SYNC_ID` (a `CONTENT_EXCEPTION_URI` split clones `_SYNC_ID`, `SYNC_DATA*` and `UID_2445`, and caps the old master's rule without `DIRTY`) | both masters are always loaded together. The download merges into the older master as a dirty item, leaves the newer one alone and heals no baseline of either. The upload resolves the split in its first step: the older master's current RRULE is uploaded, and the newer row is claimed as a new event with a fresh uid; that claim points the source's exception rows' `ORIGINAL_SYNC_ID` back at the source and sets the source `DIRTY=1`, so its capped rule uploads |
| a new master carrying another master's `UID_2445` (an app's "duplicate" copies it) | a clone without a source: claimed with a fresh uid and created as a new event, never adopting the other master's object (the engine loads every master that shares a new master's `UID_2445`) |
| event moved to another calendar, or a series turned into a single event (Etar deletes and re-inserts both) | paired with the deleted row and uploaded as a patch of the same object (see [Uploads](#uploads)); never across JMAP accounts, where the move is a create in the target account and a destroy in the source |
| `CALENDAR_ID` changed in place to a calendar of another JMAP account | not uploaded; the next download of the object puts the row back |
| an RSVP for one instance (Etar goes through `CONTENT_EXCEPTION_URI`) | the override's whole `participants` map with the user's new status. An exception row's status uploads only when the user organizes the event: Etar also puts `STATUS_CONFIRMED` on the instance, and Stalwart refuses an attendee's change to an event's status |

On an exception row an app created, an empty title, description, location or
colour, or no attendee or reminder rows, means "inherit from the series", never
a deletion. An override never carries `privacy`: Stalwart drops it from
overrides.

The first override of an event with none sends the whole `recurrenceOverrides`
map (a patch below a missing property fails).

### Other properties

| JSCalendar | Android |
|---|---|
| `title` | `TITLE` (exception rows always carry the master's title: Fossify Calendar treats an exception with an empty title as deleted) |
| `description` | `DESCRIPTION`; `descriptionContentType: text/html` is written as plain text and uploaded only when edited, then as `text/plain` |
| first entry of `locations` (server order) | `EVENT_LOCATION` ← `name`; edit patches `locations/<k>/name`, a new one adds `locations/<new>`, clearing deletes the entry |
| `status` confirmed / tentative / cancelled | `STATUS` 1 / 0 / 2; absent → 1. Never NULL (the provider throws) |
| `freeBusyStatus` busy / free | `AVAILABILITY` 0 / 1; device TENTATIVE (2) uploads as `busy` |
| `privacy` absent / public / private / secret | `ACCESS_LEVEL` DEFAULT / PUBLIC / PRIVATE / CONFIDENTIAL |
| `color` | `EVENT_COLOR` (CSS name or `#rrggbb` → ARGB; upload `#rrggbb`); no Colors table in v1 |
| participants with a `mailto:` `calendarAddress` | Attendees rows: `ATTENDEE_EMAIL` (the user's own address normalised to exactly `OWNER_ACCOUNT`: Android matches "me" case-sensitively), `ATTENDEE_NAME`, `ATTENDEE_RELATIONSHIP` (owner or organizer address → ORGANIZER, else ATTENDEE), `ATTENDEE_TYPE` (`optional` role → OPTIONAL, kind `resource`/`location` → RESOURCE, else REQUIRED), `ATTENDEE_STATUS` (accepted 1, declined 2, needs-action 3, tentative 4, delegated/other 0); participant ids stay in the shadow |
| `organizerCalendarAddress` | `ORGANIZER` when the event has participants; otherwise unset (the provider uses the owner, which keeps the event editable) |
| — | `HAS_ATTENDEE_DATA=1`; `SELF_ATTENDEE_STATUS` is never written (the provider derives it and throws on update) |
| alerts with an offset before start (`relativeTo` start or absent, offset ≤ 0) | Reminders: `MINUTES` = −offset, `METHOD` = EMAIL for `action: email`, else ALERT |
| alerts relative to the end, absolute alerts, offsets after the start | preserved, not shown |
| `useDefaultAlerts: true` | the calendar's `defaultAlertsWithTime`/`WithoutTime` become the reminders (as the app's own scheduler does); a device edit uploads `useDefaultAlerts: false` plus explicit `alerts` |
| `uid` | `UID_2445` |
| `keywords`, `categories`, `priority`, `virtualLocations`, `links`, `relatedTo`, `sequence`, `locale`, `replyTo`, locations after the first, participants without a `mailto:` address | preserved only |

Attendees upload: the user's own RSVP (their attendee row's status) patches
`participants/<id>/participationStatus`, with `sendSchedulingMessages: true`
like the app's `rsvpEvent`; on an exception row it goes into the override's
whole `participants` map. Added attendees get new participant keys with
`roles: {attendee: true}`, `participationStatus: needs-action` and
`expectReply: true`; removed ones are deleted (`participants/<id>: null` is
clean on Stalwart).

Reminders upload: the representable alerts are replaced by the device's
reminders, matched by (minutes, method) to keep existing alert keys; the others
stay. Only when the reminder owner is the device calendar app (below).

### Scheduling messages

Stalwart sends iTIP only when a `/set` asks for it
(`sendSchedulingMessages`, default false), whereas CalDAV clients get implicit
scheduling on every change. Device sync follows CalDAV's lead for changes a
calendar app would notify about:

- the user is the organizer and the event has other participants: `true` when
  title, description, timing, rule, overrides, location, status or attendees
  changed, on a create, and on destroy (CANCEL); reminders, colour,
  availability and privacy alone send nothing. An event without an organizer
  counts as the user's: once it has attendees, Stalwart makes the account's
  first address its organizer;
- the user is an attendee: `true` for their own RSVP change and on destroy
  (Stalwart sends REPLY DECLINED); other edits are stored for the user only;
- events in the past: Stalwart sends nothing anyway.

### Reminder owner

When calendar sync is turned on while `calendarNotificationsEnabled` is on, the
app asks who should remind the user, per account:

- **the calendar app** (default when Bulwark's reminders are off): Reminders
  rows are written, and Bulwark's own scheduler skips events of the synced
  calendars of that account (tasks keep their reminders);
- **Bulwark**: no Reminders rows; `MAX_REMINDERS=0` on the account's calendars
  so apps offer no reminder editor; reminder rows an app adds anyway are neither
  uploaded nor deleted.

Changing the choice requests a calendar sync. The calendar SyncState records
who the rows were written for (`reminderOwner`), so that run notices the
change: its uploads still work for the old owner, so pending reminder edits
go up first. After the upload it rewrites the Reminders rows of that account's
clean events together with their baselines, one group per event that asserts
the projection it read, and sets the calendars' `MAX_REMINDERS`; no server
writes. A reminder edit that has not reached the server is never overwritten.

## Headless payload, report and SyncResult

Payload (`RunPayload` in `src/device-sync/types.ts`):
`{ runId, accountName, registryId, authority, extras: { manual, upload,
expedited, ignoreBackoff, overrideTooManyDeletions, discardLocalDeletions },
deadline }`; only booleans cross from the framework's extras.

Report (`RunReport`): `{ v: 1, runId, authority, outcome, message?, startedAt,
durationMs, stats: { downloaded: {created, updated, deleted}, uploaded:
{created, updated, deleted}, entries, skipped }, conflicts, itemErrors[],
tooManyDeletions?: {count, threshold}, delayUntil?, moreRecordsToGet? }`.

| Outcome | Meaning | SyncResult (`SyncReports.kt`) |
|---|---|---|
| `ok` | synced; item errors may be listed | stats only |
| `io` | network or server trouble | `numIoExceptions=1` (soft: back-off; at once if progress was made) |
| `internal` | an unexpected exception | as `io` |
| `auth` | credentials rejected after a rebuild | `numAuthExceptions=1`, no progress (hard) |
| `permission` | runtime permission missing | `databaseError`, no progress (hard) |
| `unsupported` | no capability | `databaseError`, no progress |
| `safetyAbort` | empty server, full device | `databaseError`, no progress |
| `tooManyDeletions` | above the threshold | `tooManyDeletions=true`, `numDeletes` = pending deletions (the system's notification offers "delete" and "undo") |
| `cancelled` | framework cancel or out of time | stats only |
| `disabled` | sync is off | nothing |

A 429 ends the run with `io` and `delayUntil` from its `Retry-After` (epoch
seconds; 60 s when the server sends none). `delayUntil` and
`moreRecordsToGet` (→ `fullSyncRequested`) pass through. A run without a
report is a soft error. The stats count only rows actually written and objects
actually sent, so a run that repeated a page without writing anything is not
"progress" to SyncManager. A change pushed while a run is active (SyncManager
drops a `requestSync` that matches a running sync) flags the run; the adapter
reads the flag after the run is closed and then sets `fullSyncRequested`. The
push of our own upload arrives while the run is still open, so every run that
uploads gets one follow-up sync (see [Triggers](#triggers)).

## Native module API

`NativeModules.BulwarkDeviceSync` (`DeviceSyncNativeModule` in `types.ts`).
Large payloads cross as JSON strings, which the bridge moves far faster than
nested maps. Every provider call is scoped to one account of our type.

| Method | Does |
|---|---|
| `getInfo()` | `{ accountType, sdkInt }` |
| `listAccounts()` | our accounts with their `registryId` |
| `ensureAccount(name, registryId)` | adds the account (both authorities syncable, automatic off); true when created, false when it exists for the same registry id or without one (it is adopted); rejects (`conflict`) when an account of that name belongs to another registry id |
| `removeAccount(name)` | removes it; the providers drop its rows |
| `getSyncSettings(name)` | master auto-sync, and per authority: syncable, automatic, periodic seconds, active, pending |
| `setSyncEnabled(name, authority, on)` | syncable = 1 and `setSyncAutomatically` |
| `setPeriodicSync(name, authority, seconds)` | replaces our periodic syncs (including the framework's default daily one); 0 removes them; the framework clamps to 15 min |
| `requestSync(name, authority, optionsJson)` | `{manual, expedited, upload, overrideTooManyDeletions, discardLocalDeletions}` as SYNC_EXTRAS_*; constant extras so repeated requests coalesce; flags an active run for `fullSyncRequested` |
| `openAccountSettings(name)` | the account's sync screen (`android.settings.ACCOUNT_SYNC_SETTINGS` with the Account), else `SYNC_SETTINGS` filtered to our type |
| `finishRun(runId, reportJson)` / `isRunCancelled(runId)` | the run handshake |
| `setPushRoutes(json)` | `{ jmapAccountId: [{ accountName, authorities }] }` for the push router, in SharedPreferences |
| `showSyncProblem(name, title, text, uri, channelName)` / `clearSyncProblem(name)` | the account's one sync-problem notification; a tap opens `uri` (`bulwarkmobile://` only) in the app; `channelName` names the channel in the app's language |
| `query(name, authority, queryJson)` | `ProviderQuery` → `ProviderRows` |
| `applyBatch(name, authority, opsJson)` | `ProviderOp[]` → `BatchResult`; failures resolve as `{ok: false, reason}` |
| `readSyncState(name, authority)` | the SyncState blob as text |
| `readPhoto(name, rawContactId, maxPx)` | the display photo (or thumbnail), scaled, as JPEG base64 + file id |

Provider calls run one at a time on a thread of the module's own (a batch
can hold the provider for seconds at a contended yield point), through an
unstable provider client, so a provider process that dies fails the call
instead of this process. `query`, `readSyncState` and `readPhoto` reject with
code `scope`, `permission` or `provider`.

Events: `BulwarkDeviceSync:accountsChanged` (an account of our type was added
or removed; JS re-lists). Events without a JS listener are dropped, so they are
hints; the UI re-reads state on mount and on foreground.

Scoping, enforced in Kotlin for every op
(`android/app/src/main/java/com/anonymous/bulwarkmobile/sync/ProviderScope.kt`):

- URIs always carry `caller_is_syncadapter=true`, `account_name`,
  `account_type` (CalendarProvider accepts no other query parameters).
- Queries and updates/deletes by `where` get the account condition ANDed in:
  - `account_name`/`account_type` columns for raw_contacts, groups,
    settings, calendars and colors;
  - data rows are filtered by ContactsProvider itself through the account
    URI parameters (their account columns are never selected on: Android 17
    drops them from the Data view for apps targeting API 37);
  - events get `calendar_id IN` the account's calendars (CalendarProvider
    updates events on the Events table, which has no account columns);
  - attendees, reminders and extended properties get `event_id IN` the
    account's events among those the op touches (resolved first; the
    providers may compile selections strictly, so no subqueries).
- Ops by `id` verify the row belongs to the account first (`scope`
  otherwise) and expect exactly one row unless they set `expectCount`, so a
  row that vanished fails with `assert`. `id` and `where` together address
  the id row if it matches. On attendees, reminders and extended properties
  the id column is table-qualified (`Attendees._id`), since CalendarProvider
  reads attendees through a join where a bare `_id` is ambiguous; the engine
  therefore never writes `_id` into a `where` there. Extended properties are
  updated through their item URI, so by `id` only.
- Inserts into data/attendees/reminders/extended_properties/events must name a
  parent (a back-reference to an insert of the same batch, or an id); an
  insert or update naming a parent, exception master (`original_id`) or group
  (`data1` of a membership row) checks it: gone fails with `assert` (re-read
  and re-plan), another account's with `scope`. A back-reference must point
  to an earlier insert of the right table; settings inserts return no id.
- Inserts into the tables with account columns (raw contacts, groups,
  settings, calendars, colors) get `account_name` and `account_type` added,
  so calendar inserts carry them too. Otherwise
  `account_name`/`account_type`/`data_set` may only be written to restate the
  account, on the tables that have them (`scope` otherwise).
- Tables are an enumerated set per authority; anything else is refused
  (`scope`).
- Blobs (`{ b64 }`) are only accepted for `data.data15` (photos).
- A `syncState` op must be the last op of its batch and not `yieldAllowed`,
  so a provider yield never commits the state ahead of the rows (refused as
  `scope` otherwise).
- Batches: at most 499 ops up to and including each yield point
  (ContactsProvider counts an op before resetting at a yield point and throws
  at 500), about 300 KB per call; `TransactionTooLargeException` resolves as
  `tooLarge` so JS splits the batch. `OperationApplicationException` resolves
  as `assert` (except the provider's own "too many operations" and failed
  inserts, `provider`), `SecurityException` as `permission`. The whole batch
  is also refused (`scope`) once the Android account is gone, so no rows
  outlive it.

What the providers do with values, which the planners account for:

- contacts `data1`..`data14` are TEXT columns: a number written there reads
  back as a string, so mappers normalise types before comparing;
- `Events.dirty` and `Calendars.dirty` are NULL after a sync-adapter insert:
  planners write `dirty = 0` on every insert and select dirty rows with
  `dirty = 1`.

## App integration

### Store

`src/stores/device-sync-store.ts`, keyed by `AccountEntry.id`, persisted under
`device-sync:v1` with `createPersistStorage({ writeDelayMs: 0 })` (not the
1-second delayed storage) and not part of the settings export. Per account:
`contactsSelection` / `calendarSelection` (explicit choices only; unlisted
collections follow the default: the personal account's on, shared accounts'
off, and the webmail's "Trusted Senders" address book off too: it is the
allow-list of senders whose images load, not an address book people expect
in their phone's contacts), `newContactsAddressBook`, `reminderOwner`,
`intervalSeconds` per authority, the last `RunStatus` per authority,
`androidAccountName` (the Android account it uses), `knownStates` (the latest
states the engine synced, per JMAP account and type, for the echo skip),
`enabled` (what the user turned on in the app), `removedInAndroidSettings`,
`suspended` and `primaryJmapAccounts`. Android's `getSyncAutomatically` stays
the source of truth for whether an authority syncs (see Lifecycle). Headless
runs await hydration before any `set()` (zustand 5 writes on every `set()`,
even before hydration, and would overwrite the stored preferences).

### Settings sections

Android only (`supportsDeviceSync` in `platform-capabilities.ts` and the
native module present). Settings → Contacts and Settings → Calendar each get a
"Sync to this device" section with a row per signed-in account:

- an on/off switch (reflects `getSyncAutomatically`; "Paused in Android
  settings" when the account exists but the authority is off there; a hint when
  the device's master auto-sync is off);
- a chooser (sheet) for address books or calendars, with personal ones on and
  shared ones (and Trusted Senders) off by default, read-only ones marked, and
  a warning when another signed-in account already syncs the same shared
  collection;
- contacts: the address book for new contacts;
- calendar: who reminds you (calendar app or Bulwark);
- the interval: 15 min, 30 min, 1 h (default), 6 h, manual;
- "Sync now" (`requestSync` with manual + expedited);
- the last sync time and its result, or the error with an action ("Sign in
  again", "Grant access", "Review deletions");
- "Android account settings" (`openAccountSettings`).

Turning sync on asks for `READ/WRITE_CONTACTS` or `READ/WRITE_CALENDAR` after a
rationale; denied → sync stays off and the section says why, with a link to the
app's system settings when Android no longer asks.

### Lifecycle

- **Enable:** permissions → `ensureAccount` → `setSyncEnabled(true)` →
  `setPeriodicSync(interval)` → `requestSync(manual)`; push routes and push
  types are refreshed.
- **Disable an authority:** automatic sync goes off first
  (`setSyncEnabled(false)`), so no queued sync downloads everything again
  right after the rows are gone. Then the engine's teardown runs under the
  run mutex; a sync of that account and authority that holds it is asked to
  stop at its next checkpoint. The teardown uploads the authority's dirty,
  deleted and new items (bounded to 30 s; it is not a sync run, so the
  "disabled" preflight does not stop it), with the [deletion
  threshold](#deletion-threshold) applied, and never uploads rows written for
  another registry account or server (SyncState `owner`). Then it deletes the
  authority's rows and clears the SyncState by writing `''`. When items could
  not be uploaded (offline, errors, deletions above the threshold), nothing is
  deleted and the app asks: "N changes made on this device haven't reached
  the server. Turn off anyway?" Turning off anyway still makes one short
  upload attempt (5 s) before the rows go; "Keep syncing" turns automatic sync
  back on. With nothing waiting the rows go without a question: the server
  keeps everything. When both authorities are off the Android account is
  removed. Turning calendar sync off also forgets who reminds of synced
  events, so the question comes again the next time.
- **Logout** (`auth-store.logout`, `logoutAll`, `removeAccount`): the same as
  disabling both, before the credentials go, with the same question when
  changes would be lost; "stay signed in" keeps the accounts syncing. Several
  accounts are released in parallel, a toast says it is working, and an
  internal error never blocks signing out (the next reconcile suspends what
  was left).
- **Registry evictions** (the app drops an account on its own, e.g. after an
  `AuthenticationError`): reconciling Android accounts against the registry at
  launch, on foreground and whenever accounts of our type change finds an
  Android account whose registry id is gone. It is not removed: automatic
  sync is turned off and one notification says it stopped syncing ("Sign in
  again"; it gives no count of waiting changes, which would need a provider
  read). Signing in again resumes exactly the authorities that synced; the
  section lists the account with "Sign in again" and "Remove from this
  device", and removing it there or in Android Settings drops it. An empty or
  unreadable registry is never acted on.
- **Account removed in Android Settings:** detected by the accounts listener
  and on foreground; the store marks it, the switches show off, and the app
  does not recreate the account.
- The store keeps what the user turned on in the app (`enabled`) next to
  Android's switches, which stay the source of truth: an authority switched
  on in Android Settings is adopted as on, one switched off there shows as
  "Paused in Android settings" (not "Off"), and "Sync now" is disabled while
  paused, since a manual run would only report `disabled`. `suspended` marks
  an evicted account, `primaryJmapAccounts` the personal JMAP account per
  authority (push routes and the trigger filter).
- An Android account that exists without a registry id (created, then the
  app died before writing it) is adopted by the next `ensureAccount`; one
  with another registry id is refused (`conflict`) and the app uses the
  registry id as the account name instead.
- **Uninstall:** Android removes the accounts of an uninstalled authenticator,
  and the providers delete their rows.
- **Permission revoked:** Android fails the sync before our code runs
  (`databaseError`), so the section checks the permission itself and shows
  "Grant access".

### Triggers

- **Periodic sync** per the user's interval (default 1 h: push covers
  freshness).
- **Device edits:** the providers schedule upload syncs 30 s after any app
  write (`supportsUploading`).
- **App running:** SSE `StateChange` for `AddressBook`/`ContactCard` or
  `Calendar`/`CalendarEvent` on a synced account (`onStateChangeType` in
  `state-change-bus.ts`; the stream serves the active account), the app's own
  successful contact/calendar mutations (store actions), and returning to the
  foreground → `requestSync` for that authority. The first request of an
  account and authority arms a 5 s timer and later ones ride along (the timer
  is not restarted), so an edit and the StateChange echoing it make one sync.
  A StateChange whose state equals the one the engine last recorded is our
  own echo and is skipped, also when the engine recorded it while the timer
  ran. Foreground requests go out at most once a minute per account and
  authority, and the launch counts as one. Edits that change no device row
  (tasks, calendar sharing, the default collections) request nothing. These
  are ordinary requests, which Android drops while the account is paused.
- A push with no readable `changed` map (older relays) starts the mail task
  as before and requests no syncs; periodic syncs cover those setups.
- Every run that uploads gets one follow-up sync: the server's push of our
  own change arrives while the run is open, and SyncManager drops a request
  matching the running sync, so the run asks for another one when it ends.
  The follow-up finds nothing to do, so it stays one.
- **App closed:** while an account has device sync on, its push subscription
  adds `ContactCard`, `AddressBook` (contacts) and `CalendarEvent`, `Calendar`
  (calendar) to `EmailDelivery`, per account. Turning sync on or off updates
  the subscription right away; for a signed-in account other than the one the
  UI serves, through a client of its own, never the UI's singleton. The relay
  forwards the StateChange's `changed` map verbatim (FCM data key `changed`;
  only its first account key is repeated as `accountId`). A native router in
  the FCM and UnifiedPush services walks every account key of `changed`, maps
  contact and calendar types to `requestSync` through the routes JS stored
  (`setPushRoutes`; the device-sync layer refreshes them whenever the device
  sync preferences change), and starts the mail push task only when some
  account's map has `EmailDelivery`. A guard at the top of
  `pushBackgroundTask` returns for StateChanges without `EmailDelivery`, so a
  contact change can never take the legacy "notify the newest unread mail"
  path.

## Failure matrix

| Failure | What happens | Recovery |
|---|---|---|
| No network | `io` → back-off (30 s ×2, max 1 h) | automatic |
| Network lost mid-upload | the `/set` may have applied: a create's row is adopted by uid on the next download or lookup, patches re-apply idempotently | automatic |
| Process killed mid-sync | no report: soft error; the state was only advanced with complete chunks | next run repeats the page; echo writes are no-ops |
| OAuth token expired | the client refreshes; a rotated token held by another client → rebuild once | automatic, else `auth` + notification |
| Password revoked | `auth` (hard, no retry) + "Sign in again" | user signs in; the next trigger syncs |
| Permission revoked | Android fails the sync (`databaseError`) | "Grant access" in settings |
| `cannotCalculateChanges` | full reconcile of that JMAP account | automatic |
| Server `SetError` on an item | notFound on an update → local delete; forbidden with scheduling → retried without it ("invitations not sent"); forbidden on an update or deletion → rows rewritten from the server's current version; forbidden on a create, and the rest → poisoned with back-off, listed in the report | automatic / user fixes the item |
| A whole `/set` refused for an account (`accountReadOnly`, `forbidden`, `accountNotFound`, `accountNotSupportedByMethod`) | that account's items wait, the report lists the account; the other accounts go on | automatic once the account takes writes |
| A shared account refuses to list its address books or calendars (`forbidden`, `accountNotFound`, `accountNotSupportedByMethod`) | the account is left out of the run and only logged; its rows stay untouched | automatic once it lists them again |
| A planner throws on an item | download: the object goes on `stale`; upload: the item is skipped (`plannerError`); the rest of the run goes on | fixed in code; listed in the report |
| `stateMismatch` or `serverUnavailable` on a `/set` | re-download, retry up to 3 times, then `io` without progress | automatic (back-off) |
| 429 | `io` with `delayUntil` = Retry-After (60 s without one) | automatic |
| Too many local deletions | `tooManyDeletions` + system notification | user picks delete or undo |
| Empty server on a full reconcile | `safetyAbort`, device untouched | user checks the server; turning sync off and on starts over |
| Edit during an upload | clearing assert fails → DIRTY stays, shadow updated | next run uploads the newer edit |
| JS crash or reload mid-run | task ends without report → soft error | automatic |
| React fails to start (debug without Metro) | boot fault → soft error in ~2 s | automatic |
| Account removed in Settings | providers drop rows; app turns sync off | user turns it on again |
| Logout / turning sync off | pending changes uploaded first; if that fails (or deletions exceed the threshold) the user is asked before anything is deleted | — |
| Provider refuses a batch (`assert`/`tooLarge`/`provider`) | per-item retry / split; an item that still fails goes on `stale` (the state still advances) and uploads nothing until it was fetched again | automatic, or listed in the report |
| App drops the account from its registry (e.g. after an auth error) | Android account kept, sync off, one "Sign in again" notification without a count of waiting changes; the section lists the account | user signs in again, or removes it from the device |
| Rows written for another server or registry account (SyncState `owner`) | the run stops with `internal`; the settings show its message | turning sync off and on starts over; the teardown uploads nothing for the other owner and asks before its changes are lost |
| DST-ambiguous start on a recurring event, unrepresentable rule | item skipped and reported with a reason (`dstAmbiguous`, `ruleNotRepresentable`); device shows it, never uploads its timing | limitation |

## Limits and performance

- JMAP: `maxObjectsInGet/Set` (500 on Stalwart), `maxCallsInRequest` (16),
  `maxConcurrentRequests` (4, shared with the UI: the engine keeps one request
  in flight), `maxSizeRequest` (10 MB; the engine targets 1 MB), queries of at
  most 5000 ids per call, `/changes` pages of 256 (Stalwart caps at 5000),
  cards and events of at most 512 KiB.
- Provider: ≤ 499 ops between yield points (the engine packs at most 400 per
  batch), ~300 KB per `applyBatch`, photos in their own batch; 50 raw contacts
  or 50 events per chunk.
- JS thread: a `setTimeout(0)` yield between chunks, so the UI keeps rendering
  when the app is open; JSON crosses the bridge as strings.
- Time: 9.5 min per run (2.5 min expedited), checkpoints between chunks,
  continuation through `fullSyncRequested`. Checkpoints stop 30 s before the
  payload's deadline and a create batch needs 60 s left (see [A sync
  run](#a-sync-run)), so an expedited sync that cold-starts React Native has
  little room for creates.
- Contacts: the first card with a relation to name, or the first change of a
  group's members, reads every synced contact's shadow (`SYNC2`) once per run
  to index the cards by uid.

The 2,000 + 2,000 scale run is recorded in the parity notes when #34 closes.

## Testing

- **Pure units** (vitest): mappers with golden fixtures, one field per test,
  and round-trip properties (server → rows → projection equals the server's
  mapped subset; unmapped data survives edits); RRULE, EXDATE, durations, time
  zones, floating, all-day, DST edges of rules, exceptions, splits, reminders,
  attendees; merge rules; the import-graph purity test.
- **Engine** (vitest): `src/device-sync/__tests__/fakes/fake-provider.ts`, an
  in-memory ProviderPort with DIRTY/DELETED/VERSION, soft/hard deletes,
  asserts, back-references, yield points and user-edit helpers (AOSP-style
  in-place edits and Fossify-style delete+reinsert); and a fake JMAP server
  for ContactCard/CalendarEvent/AddressBook/Calendar with `/changes`,
  `cannotCalculateChanges`, `ifInState`, SetError injection, the async uid
  index and Stalwart's key behaviour. Crash injection at every checkpoint;
  poison items; the deletion guards; echo suppression; an edit during upload.
- **Kotlin** (JUnit, `gradlew :app:testDebugUnitTest`): report mapping, op and
  URI translation, scoping.
- **Device** (API 34 and 32 emulators, local Stalwart only): the scenario matrix
  in the #34 parity note, verified on three sides: the provider (`adb shell
  content query …`), the server (JMAP calls) and the apps' UI. Debug builds
  create accounts without UI:

  ```
  adb shell am broadcast -n com.anonymous.bulwarkmobile/.sync.DeviceSyncDebugReceiver \
    --es cmd ensure --es name <name> --es registry <AccountEntry.id> --es enable contacts,calendar
  adb shell requestsync -n <name> -t com.anonymous.bulwarkmobile.account -a com.android.contacts --manual
  ```

## Decisions and limitations

Decisions made where the brief left a choice (safe defaults):

- Default reminder owner when Bulwark's reminders are off: the calendar app.
- Delete on the device + edit on the server: the delete wins.
- Deletion threshold: > 50 and > 20 % of the authority's objects.
- Full-reconcile safety: more than 10 device rows against an empty server.
- Turning a Contacts/Calendar toggle off in Android Settings pauses sync and
  keeps the data, like Google accounts; turning it off in the app also removes
  the data.
- Events that are only in unselected calendars, and cards only in unselected
  address books, are not on the device; an event in several calendars lives in
  the first selected one (by id), a move on the device patches only that
  membership, and a deletion removes only the selected memberships.
- A shared collection that another signed-in account already syncs gets a
  warning in the chooser, not a refusal.
- An app account dropped from the registry keeps its Android account (sync
  off) until the user signs in again or removes it: its device changes would
  otherwise be lost.
- A shared account that refuses to list its address books or calendars is
  left out of the run and only logged, not reported: Stalwart lists an account
  shared for mail only with every capability, so the warning would never go
  away. Its rows stay on the device, since a refusal can pass.
- The user's own address for "me" and `OWNER_ACCOUNT`: the session login when
  it is an email address, else the first identity's address; aliases from
  identities also count as "me".

Known limitations:

- Google Contacts may not show or edit third-party accounts (closed source;
  DAVx5 reports the same); AOSP-based and Fossify Contacts do.
- Fossify Contacts re-inserts rows on save: a field or entry it does not model
  (a second nickname or organization, a department, a label) is kept on the
  server, but an entry deleted or a field cleared in Fossify is not deleted or
  cleared on the server, and comes back on the device with the contact's next
  clean write. Fossify Calendar's rule edits upload only in the parts its
  editor models.
- Android shows extra instances for BYSETPOS rules other than monthly-BYDAY,
  and none for a daily series older than about 5.5 years (AOSP's 2000-period
  expansion cap).
- Rules with `rscale`/`skip`/leap months: shown approximately, timing never
  uploaded. `EXRULE` is not supported by Stalwart.
- Recurring events whose start or override falls in a DST overlap cannot be
  uploaded (Stalwart drops ambiguous local times).
- An `UNTIL` in a DST gap or overlap moves one hour later, so an Etar "this
  and following" split exactly at an instance inside the repeated hour can
  include that instance in the old series again (better than Stalwart
  dropping the `UNTIL`).
- A single occurrence that Stalwart holds only as an instance (no master) is
  shown but read-only.
- In a calendar that grants RSVP but no writes, only the user's answer to the
  whole series uploads; an answer for one instance is reverted.
- Moving an event to a calendar of another JMAP account uploads as a create in
  the target account and a destroy in the source (a new uid; participants are
  notified accordingly). An app that moves it by changing `CALENDAR_ID` in
  place gets the row put back by the next download of the event.
- Descriptions over 64 KB are shown truncated and are not uploaded when edited.
- A shared address book or calendar that two signed-in accounts can both see
  appears once per account when both sync it (each Android account holds its
  own copy).
- Floating events follow the device zone; alerts relative to the end, absolute
  alerts and alerts after the start are kept on the server but not shown.
- Photos travel as 512 px JPEG `data:` URIs; a larger original is replaced by
  its scaled copy only when the user changes the photo on the device.

Open:

- Contacts: a custom `name/full` is kept even when a component edit makes it
  stale; a group title cleared on the device is not uploaded; clearing company
  and department leaves an organization entry without a name on the server.
- Calendar: a recurrence id in a repeated hour uses the first instant (RFC
  5545) for `ORIGINAL_INSTANCE_TIME`; to be checked against CalendarProvider's
  instance expansion on a device.

## Out of scope

Possible follow-ups:

- **iOS.** iOS has no third-party sync-provider API for Contacts or Calendar.
  The realistic route is a CalDAV/CardDAV configuration profile, which Stalwart
  already serves.
- **Tasks** through the OpenTasks provider.
- **A contacts Directory provider** for server-side search.
- **Importing device-local contacts** into Bulwark.
- An account-scoped Colors table so calendar apps can offer event colours.
- Re-basing old daily/hourly series past AOSP's 2000-period expansion cap.
