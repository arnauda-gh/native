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
  import graph of `src/device-sync/{contacts,calendar,engine}` and fails on
  `react-native`, expo, stores or `jmap-client`: the global mocks in
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
| `src/device-sync/native.ts` | typed wrapper around `NativeModules.BulwarkDeviceSync` |
| `src/device-sync/common/` | pure helpers: canonical JSON, hashing, JSON Pointer patches, zoned time, durations |
| `src/device-sync/contacts/` | JSContact ↔ contacts rows, row matching, contact merge rules (pure) |
| `src/device-sync/calendar/` | JSCalendar ↔ calendar rows, RRULE, exceptions, merge rules (pure) |
| `src/device-sync/jmap/` | the JMAP side on a detached client: `/changes`, full reconcile, `/set`, uid lookup |
| `src/device-sync/engine/` | orchestration: run entry, mutex, checkpoints, batches, SyncState, report |
| `src/device-sync/task.ts` | the headless task entry (registered in `index.ts`) |
| `src/stores/device-sync-store.ts` | per-account preferences and the last run status |
| `src/components/settings/ContactsSettings.tsx`, `CalendarSettings.tsx` | the "Sync to this device" sections |

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
pending. DIRTY is not the test: a raw contact inserted without data rows is not
dirty. A row with `ORIGINAL_*` set is always an exception of its master and
never uploads as an event of its own.

### Contacts columns

| Column | Holds |
|---|---|
| `RawContacts.SOURCE_ID` | identity (above) |
| `RawContacts.SYNC1` | the card's collections: `<jmapAccountId>/<addressBookId>` joined by `,` |
| `RawContacts.SYNC2` | the shadow: the last server card, wire format, with each `data:` photo URI replaced by `sha256:<hex>` of its bytes |
| `RawContacts.SYNC3` | the pending create: `{"uid":…,"target":"<jmapAccountId>/<addressBookId>"}`, written before the `/set` and kept until the identity is |
| `RawContacts.SYNC4` | poison marker `{"fp":…,"type":…,"n":…,"until":…}` |
| `RawContacts.RAW_CONTACT_IS_READ_ONLY` | 1 when none of the card's address books grants `mayWrite` |
| `Data.DATA_SYNC1` | the entry key(s), e.g. `emails:work1`; see [units](#units) |
| `Data.DATA_SYNC2` | photo rows: the hash of the server photo applied to the row |
| `Data.DATA_SYNC3` | the baseline: the row's mapped columns as the provider stored them after our last write (JSON; text over 1 KB as its hash) |
| `Groups.SOURCE_ID`, `SYNC2`, `SYNC3`, `SYNC4` | as for raw contacts, for group cards (`SHOULD_SYNC` is never written: an update carrying it makes ContactsProvider request a sync) |
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
| `Calendars.CAL_SYNC3` | flags JSON: `readOnly` reason (`rights`, `subscription`), `taskOnly` |
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

A description longer than 64 KB is written truncated, marked in the baseline,
and never uploaded: an event row carries the description, the shadow and the
baseline, and one Binder transaction holds 1 MB.

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
  "deviceZonePending": null
}
```

- `owner`: the registry account and the server origin the rows were written
  for. A run for another owner stops with `internal` and the app offers to
  start over (after uploading what it can).
- `itemsState` is the `ContactCard` or `CalendarEvent` state the rows describe.
  It is written in the same `applyBatch` as the last item group of a `/changes`
  page: the `syncState` op is the last op of that batch, is never
  `yieldAllowed`, and the native side refuses a batch that breaks either rule,
  so a provider yield can never commit the state ahead of its rows.
- No stored `itemsState` is newer than the shadow of an object changed before
  it: an object whose rows could not be written (an item error) goes on
  `stale` in the same batch, is fetched again at the start of every run, and
  uploads nothing until it has been.
- `reconcile` marks a full reconcile in progress: `{ "from": <state taken
  first>, "phase": "ids" | "objects", "position": n }`, written with every
  chunk. The next run continues it; its deletions are applied only when the
  complete id list is known, and `itemsState` becomes `from` when it ends.
- `selected` is the selection the rows were written for; a collection is added
  in the batch with its last loaded chunk, and removed with its last deleted
  row.
- `groups` (contacts): the group cards present on the device, so a group an app
  hard-deleted (Fossify does) is recognised by its absence.
- `taskOnly` lists calendars found to hold only tasks.
- `deviceZone` (calendar) is the zone floating events were written in;
  `deviceZonePending` is set while a zone-change pass runs and cleared, with
  `deviceZone` updated, in the batch of its last chunk.
- The providers delete the row with the account.

## A sync run

One run handles one Android account and one authority. A module-level mutex per
(registry account, authority) serialises it with other runs and with app-side
operations such as turning sync off.

1. **Preflight.**
   - Permissions for the authority (a revoked one → `permission`).
   - The Android account and that the authority is still enabled
     (`getSyncAutomatically`) → otherwise `disabled`.
   - The SyncState's `owner` matches this registry account and server origin
     (see [Identity](#identity)).
   - `new JMAPClient().loadAccount(registryId)`: `false` or
     `AuthenticationError` → rebuild once (another client may have rotated
     the refresh token); still failing → `auth`, plus one notification that
     deep-links to sign-in. Nothing local is touched.
   - The capability on at least one JMAP account → else `unsupported`.
   - An upload-only sync (`extras.upload`) with nothing dirty, deleted or new
     for our account ends here with `ok`: ContactsProvider and CalendarProvider
     schedule an upload sync for every account 30 s after any app write, other
     accounts' included.
2. **Local checks.** Calendar: two masters sharing a `_SYNC_ID` (a
   `CONTENT_EXCEPTION_URI` split, which also caps the old master's rule
   without DIRTY) are resolved before any merge or baseline heal: the newer row
   becomes a new event and the older master's rule is uploaded as it stands.
   Objects on `stale` are fetched again.
3. **Collections.** `AddressBook/get` or `Calendar/get` (explicit properties)
   for the primary JMAP account of the capability (`primaryAccounts[capability]`)
   and every shared account that advertises it; calendar rows are inserted and
   updated to match. Newly selected collections are loaded after step 4 has
   brought the account up to date, restricted to them, so the stored state
   never skips changes of the other collections. Deselected collections are
   dropped after step 5, and only their clean rows go: dirty items there are
   uploaded first (they are still valid objects on the server), and an item
   whose upload failed keeps its rows and is reported.
4. **Download.**
   - With a stored `itemsState`: `/changes` with `maxChanges: 256` and a
     `hasMoreChanges` loop; each page's changed ids are fetched with explicit
     `properties` in batches of `maxObjectsInGet`.
   - Without a state, or on `cannotCalculateChanges`: a full reconcile,
     checkpointed in `reconcile` (see [SyncState](#syncstate)). The state is
     taken first (`/get` with `ids: []`), then every selected collection's ids
     (`/query`, `inAddressBook`/`inCalendar`, `limit` 5000 with `position`
     paging), then the objects in batches. Rows without an identity or with a
     pending one (and exceptions of pending masters) are never reconcile
     deletions. A reconcile that finds zero remote objects while the device
     holds more than 10 rows for that JMAP account stops with `safetyAbort`
     instead of wiping the device.
   - An object without rows first looks for a local item it may already be:
     a new row of the same JMAP account whose pending uid is the object's
     `uid` (our own create whose identity never got written) is adopted: it
     takes the identity and shadow and is merged as a dirty item.
   - Each object is [merged](#merge-rules) into its rows. An object that left
     every selected collection loses its rows only when they are clean; dirty
     units are uploaded first.
   - Rows are written in chunks; the new state goes into the last chunk of each
     page, so every page is a checkpoint.
5. **Upload**, always after download so merges see the latest server truth; see
   [Uploads](#uploads).
6. **Report** counts, conflicts, per-item errors and duration; persist the
   status for the settings UI; call `finishRun` before the task's promise
   settles (JS timers stop once the task is over).

`/get` always lists `properties` explicitly: with `properties: null` Stalwart
leaves out JMAP-only fields such as `useDefaultAlerts`, and `ids: null` returns
at most 500 objects without saying so.

Checkpoints sit between chunks and phases. At each one the run checks
`isRunCancelled`, its deadline and the time since the last JMAP request. When
the deadline is near it stops cleanly and reports `moreRecordsToGet`, which
the adapter turns into `fullSyncRequested` (SyncManager ignores
`moreRecordsToGet` itself). The step from a create's `/set` to its identity
write is not interruptible, and a create batch starts only while at least two
request timeouts (60 s) of budget remain.

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
   row by uid, and an upload looks the uid up and adopts what it finds, so a
   retry never duplicates on either side.
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
- `timing` and `rule` of a recurring master are never healed: a
  `CONTENT_EXCEPTION_URI` split changes them without DIRTY (see the
  [local checks](#a-sync-run)).

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
   when the kind still has rows that carry keys** (an in-place editor removed
   one). When every row of the kind is keyless, an editor rewrote them all, and
   a missing entry may just be one it could not show: it stays on the server.

A row matched by its key is compared column by column with its baseline; an
emptied column is a real deletion. A row matched by value has no baseline: its
primary value uploads when it differs from the shadow's projection, its TYPE
and LABEL only for phones, emails, addresses and events (editors that re-insert
rows write a constant type for websites), and never `IS_PRIMARY`; an empty
column never clears anything.

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

Per JMAP account, in this order: pairs (below), creates, updates, deletions,
then group memberships; in `/set` calls of at most `maxObjectsInSet` objects
(creates: 50) and about 1 MB of JSON (Stalwart splits bigger calls into
several commits, which can apply partially), one request in flight, and one
`sendSchedulingMessages` value per call (it is a request-level flag).

- **ifInState.** Every `/set` carries `ifInState` = the item state the merge
  was based on (then the `newState` of our previous `/set`). A `stateMismatch`
  means the server changed since the download: the run downloads again and
  retries the upload, at most three times, then reports `io` without progress
  (SyncManager would otherwise retry at once, without back-off).
- **Pairs.** Some apps turn an edit into a delete plus an insert: Etar moves an
  event to another calendar that way, and turns a recurring series into a
  single event (or edits "this and following" from its first instance) the
  same way. A deleted row and a new row of the same run whose projections
  match apart from the calendar (or the rule) are uploaded as a patch of the
  existing object (`calendarIds` swapped; `recurrenceRule: null` with its
  overrides removed); the new row takes the identity and exceptions of the old
  one, which is purged. Across JMAP accounts a move is a create in the target
  account first, identity written, then a destroy in the source (the engine
  records its own destroys so the next download treats them as echoes).
  Unpaired rows are ordinary creates and deletions.
- **New rows** (see [Identity](#identity) for what counts as new):
  1. Claim: write the pending create (`SYNC3` / `SYNC_DATA3`: the uid and the
     target collection; for events also `UID_2445` and
     `_SYNC_ID = ~pending/<uid>`). A row keeps a uid it already carries unless
     another row, synced or pending, uses the same uid (a
     `CONTENT_EXCEPTION_URI` split clones `UID_2445`); a server object with
     that uid does not count, because it may be this row's own earlier create.
     The target is fixed at the claim: contacts go to the address book chosen
     in the settings if it is selected and writable, else the first selected
     writable book of the personal account (none → the item is poisoned with
     `noWritableAddressBook`); events go to the calendar of their row.
  2. Look the uid up: contacts in the target address book (card uids are
     unique per book), events in the whole account (event uids are unique per
     account). A hit is adopted: the row takes its identity and is merged as a
     dirty item.
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
  `recurrenceOverrides/<key>` of their master, after the master's create when
  the master is new.
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
  per item that first asserts the VERSION/projection read before the upload
  and clears DIRTY. If the assert fails (edited again meanwhile), the shadow and
  identity are still written, the baselines of the uploaded units are set to
  the values that were uploaded, and DIRTY stays: the newer edit uploads next
  time, and so does a revert to the old value.
- **SetErrors**:
  - `notFound` on update → treated as a remote delete (the rows go);
  - `forbidden` in a call that asked for scheduling messages → the item is
    retried once without them and the report notes "invitations not sent"
    (Stalwart refuses scheduling when it is disabled, when the account has no
    calendar address, or without the scheduling permission); `forbidden`
    otherwise → the rows are rewritten from the shadow (read-only on the server
    after all);
  - `stateMismatch` → as above;
  - `invalidProperties` on `uid` → as above;
  - `invalidProperties`, `invalidPatch`, `tooLarge`, `overQuota` and the rest →
    the item is poisoned: its marker records a fingerprint of the patch and a
    back-off (1 h, doubling to 1 day). It is not retried until the back-off
    ends or the row changes, and the report lists it.

### Deletion threshold

More than 50 local deletions of an authority in one run, and more than 20 % of
that authority's synced objects, set `tooManyDeletions` unless the run carries
`overrideTooManyDeletions`. Deletions inferred from absence (groups) count.
No deletion of that run is uploaded; everything else proceeds. With
`discardLocalDeletions`, the deleted rows are purged and, in the same batch, the
affected JMAP accounts get a `reconcile` marker, so the next runs download the
objects again whatever their extras.

## Contacts mapping

JSContact (RFC 9553) as Stalwart stores it, to ContactsContract. Anything not
listed is preserved through patching. Data rows are written with both the
display name and the components (the provider recomputes whichever is missing),
and every entry row stores its key(s) in `DATA_SYNC1`.

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
was derived too.

### Entries

| JSContact | Android kind | Columns |
|---|---|---|
| `nicknames/<k>` | Nickname | `NAME`, `TYPE=DEFAULT` |
| `emails/<k>` | Email | `ADDRESS`; `TYPE` from contexts: `private`→HOME, `work`→WORK, none→OTHER, `label`→CUSTOM+`LABEL`; `pref=1`→`IS_PRIMARY` |
| `phones/<k>` | Phone | `NUMBER`; `TYPE` from features + contexts (table below); `label`→CUSTOM+`LABEL`; `pref=1`→`IS_PRIMARY` |
| `addresses/<k>` | StructuredPostal | components → `STREET`, `POBOX`, `NEIGHBORHOOD`, `CITY`, `REGION`, `POSTCODE`, `COUNTRY` (table below), `full`→`FORMATTED_ADDRESS`; contexts → TYPE HOME/WORK/OTHER, `label`→CUSTOM |
| `organizations/<k>` + `titles` pointing at it | Organization | `name`→`COMPANY`, `units` joined with `, `→`DEPARTMENT`, title with `kind: title`→`TITLE`, title with `kind: role`→`JOB_DESCRIPTION`; key `organizations:<k>|titles:<t>,<r>`; titles without an organization get their own row |
| `links/<k>` | Website | `URL` ← `uri`; contexts `private`→HOME, `work`→WORK, else OTHER; `label`→CUSTOM |
| `anniversaries/<k>` | Event | `START_DATE`: `YYYY-MM-DD`, `--MM-DD` without year (`partialDateToString`); kind `birth`→BIRTHDAY, `wedding`→ANNIVERSARY, `other`→OTHER, anything else → CUSTOM + its kind as `LABEL` |
| `relatedTo/<uri>` | Relation | `NAME` ← the key (a `urn:uuid:` of a synced card shows that card's name), `TYPE` from the relation set (table below) |
| first entry of `notes` | Note | `NOTE` ← `note` |
| first `media` entry with `kind: "photo"` | Photo | full-size bytes into `PHOTO`; the provider scales them, stores the display photo and sets `PHOTO_FILE_ID` |
| group cards (`kind: "group"`) | Groups | `TITLE` ← `name.full`; `GROUP_VISIBLE=1`; `members` keys are uids of the member cards |
| membership | GroupMembership | one row per group card whose `members` holds this card's `uid` (`GROUP_SOURCE_ID`) |

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
components and never written.

Relations: `friend`↔FRIEND, `spouse`↔SPOUSE, `child`↔CHILD, `parent`↔PARENT,
`sibling`→RELATIVE, `kin`→RELATIVE, `co-worker`/`colleague`→CUSTOM with the
type as label, `agent`→ASSISTANT, `emergency`→CUSTOM. Device types without an
RFC 9553 equivalent (BROTHER, SISTER, MOTHER, FATHER, MANAGER, ASSISTANT,
DOMESTIC_PARTNER, PARTNER, REFERRED_BY) upload as the nearest RFC type
(`sibling`, `parent`, `colleague`, `agent`, `spouse`, `spouse`, `contact`) and are
only sent when the user changed the type.

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
(Binder budget).

Groups: created before memberships (a membership naming an unknown
`GROUP_SOURCE_ID` makes the provider create an empty group). A group deleted on
the device is found by `DELETED`, or by its absence from the rows while
`SyncState.groups` still lists it (Fossify hard-deletes groups through a
sync-adapter URI); both count toward the deletion threshold.

## Calendar mapping

### Calendar rows

| JMAP `Calendar` | Android `Calendars` |
|---|---|
| `id` | `_SYNC_ID` = `<jmapAccountId>/<id>` |
| `name` | `NAME`, `CALENDAR_DISPLAY_NAME` (shared accounts append the account's name) |
| `color` | `CALENDAR_COLOR` (CSS color → ARGB; absent → the app's default palette colour) |
| `myRights` | `CALENDAR_ACCESS_LEVEL`: `mayWriteAll` → OWNER (700); `mayWriteOwn` → CONTRIBUTOR (500); `mayRSVP` → RESPOND (300); else READ (200); subscribed iCal feed → READ |
| the user's calendar address | `OWNER_ACCOUNT` (never null: Etar crashes on it) |
| `timeZone` | `CALENDAR_TIME_ZONE` (device zone when null) |
| — | `SYNC_EVENTS=1` (the default 0 hides every instance), `VISIBLE=1` on insert only (local afterwards), `ALLOWED_REMINDERS="1,2"`, `ALLOWED_AVAILABILITY="0,1"`, `ALLOWED_ATTENDEE_TYPES="0,1,2,3"`, `MAX_REMINDERS=5` (0 when Bulwark owns reminders), `CAN_ORGANIZER_RESPOND=0`, `CAN_PARTIALLY_UPDATE=0` |

Not synced: the virtual birthday calendar (client-side only), calendars
without `mayReadItems`, and task-only calendars: a calendar whose first 50
objects are all `@type: "Task"` (`isTaskLikeObject`), re-checked on each full
reconcile.

Deleting a calendar row deletes its events (provider trigger); the engine
first uploads the calendar's dirty events.

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
comes from CalDAV DTEND). A duration with a time part on an all-day event is
rounded up to whole days on the device and never uploaded unless changed.

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
  uploaded: the item is poisoned with `dstAmbiguous`;
- an `until` in a gap or overlap moves one hour later.

### Recurrence

| JSCalendar | Android |
|---|---|
| `recurrenceRule` | `RRULE`: `FREQ`, `INTERVAL` (>1), `COUNT`, `UNTIL` (UTC `…Z` for timed events, `YYYYMMDD` for all-day), every `BY*` part, `BYSETPOS`, `WKST` (when not Monday) |
| `rscale` other than gregorian, `skip`, leap months (`byMonth` with `L`) | not representable: the rule is written without them, the event's timing and rule are never uploaded, and the item is marked `ruleNotRepresentable` |
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
| master `RRULE` capped with `UNTIL`/`COUNT` + a new event without identity (Etar "this and following") | `recurrenceRule` (whole object) with the new `until`/`count`, overrides after it removed (`recurrenceOverrides/<key>: null`), and the new event created with a fresh uid |
| master start moved (Etar "all events") | `start`/`duration`/`timeZone`, and every override key moved by the same local offset (overrides whose `start` equalled their old key move too), sent as the whole `recurrenceOverrides` map |
| two masters with the same `_SYNC_ID` (a `CONTENT_EXCEPTION_URI` split clones `_SYNC_ID`, `SYNC_DATA*` and `UID_2445`, and caps the old master's rule without `DIRTY`) | found before any merge or baseline heal: the newer row becomes a new event (fresh uid), the older master's current RRULE is uploaded |
| event moved to another calendar, or a series turned into a single event (Etar deletes and re-inserts both) | paired with the deleted row and uploaded as a patch of the same object (see [Uploads](#uploads)) |
| an RSVP for one instance (Etar goes through `CONTENT_EXCEPTION_URI`) | the override's whole `participants` map with the user's new status |

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
  changed, and on destroy (CANCEL); reminders, colour, availability and
  privacy alone send nothing;
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

Changing the choice first uploads pending reminder edits (a normal run), then
rewrites the Reminders rows of that account's events together with their
baselines, one group per event that asserts the projection it read; no server
writes.

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

`delayUntil` (a 429's `Retry-After`, epoch seconds) and `moreRecordsToGet`
(→ `fullSyncRequested`) pass through. A run without a report is a soft error.
The stats count only rows actually written and objects actually sent, so a run
that repeated a page without writing anything is not "progress" to SyncManager.
A change pushed while a run is active (SyncManager drops a `requestSync` that
matches a running sync) flags the run; the adapter reads the flag after the run
is closed and then sets `fullSyncRequested`.

## Native module API

`NativeModules.BulwarkDeviceSync` (`DeviceSyncNativeModule` in `types.ts`).
Large payloads cross as JSON strings, which the bridge moves far faster than
nested maps. Every provider call is scoped to one account of our type.

| Method | Does |
|---|---|
| `getInfo()` | `{ accountType, sdkInt }` |
| `listAccounts()` | our accounts with their `registryId` |
| `ensureAccount(name, registryId)` | adds the account (both authorities syncable, automatic off); true when created, false when it exists for the same registry id; rejects (`conflict`) when an account of that name belongs to another registry id |
| `removeAccount(name)` | removes it; the providers drop its rows |
| `getSyncSettings(name)` | master auto-sync, and per authority: syncable, automatic, periodic seconds, active, pending |
| `setSyncEnabled(name, authority, on)` | syncable = 1 and `setSyncAutomatically` |
| `setPeriodicSync(name, authority, seconds)` | replaces our periodic syncs (including the framework's default daily one); 0 removes them; the framework clamps to 15 min |
| `requestSync(name, authority, optionsJson)` | `{manual, expedited, upload, overrideTooManyDeletions, discardLocalDeletions}` as SYNC_EXTRAS_*; constant extras so repeated requests coalesce; flags an active run for `fullSyncRequested` |
| `openAccountSettings(name)` | the account's sync screen (`android.settings.ACCOUNT_SYNC_SETTINGS` with the Account), else `SYNC_SETTINGS` filtered to our type |
| `finishRun(runId, reportJson)` / `isRunCancelled(runId)` | the run handshake |
| `setPushRoutes(json)` | `{ jmapAccountId: [{ accountName, authorities }] }` for the push router, in SharedPreferences |
| `query(name, authority, queryJson)` | `ProviderQuery` → `ProviderRows` |
| `applyBatch(name, authority, opsJson)` | `ProviderOp[]` → `BatchResult`; failures resolve as `{ok: false, reason}` |
| `readSyncState(name, authority)` | the SyncState blob as text |
| `readPhoto(name, rawContactId, maxPx)` | the display photo (or thumbnail), scaled, as JPEG base64 + file id |

Events: `BulwarkDeviceSync:accountsChanged` (an account of our type was added
or removed; JS re-lists). Events without a JS listener are dropped, so they are
hints; the UI re-reads state on mount and on foreground.

Scoping, enforced in Kotlin for every op:

- URIs always carry `caller_is_syncadapter=true`, `account_name`,
  `account_type` (CalendarProvider accepts no other query parameters).
- Queries and updates/deletes by `where` get the account condition ANDed in:
  `account_name/account_type` columns for raw_contacts, groups, settings,
  calendars, events, colors; for data rows, `raw_contact_id IN` our raw
  contacts; for attendees, reminders and extended properties, `event_id IN`
  our events (resolved first; the providers may compile selections strictly,
  so no subqueries). Ops by `id` verify the row belongs to the account first
  and expect exactly one row.
- Inserts into data/attendees/reminders/extended_properties/events must name a
  parent of the account (a back-reference to an insert of the same batch, or
  an id that is verified).
- Tables are an enumerated set per authority; anything else is refused
  (`scope`).
- Blobs (`{ b64 }`) are only accepted for `data.data15` (photos).
- A `syncState` op must be the last op of its batch and not `yieldAllowed`,
  so a provider yield never commits the state ahead of the rows (refused as
  `scope` otherwise).
- Batches: at most 499 ops between yield points (ContactsProvider throws at
  500), about 300 KB per call; `TransactionTooLargeException` resolves as
  `tooLarge` so JS splits the batch. `OperationApplicationException` resolves
  as `assert`, `SecurityException` as `permission`.

## App integration

### Store

`src/stores/device-sync-store.ts`, keyed by `AccountEntry.id`, persisted under
`device-sync:v1` with `createPersistStorage({ writeDelayMs: 0 })` (not the
1-second delayed storage) and not part of the settings export. Per account:
`contactsSelection` / `calendarSelection` (explicit choices only; unlisted
collections follow the default: the personal account's on, shared accounts'
off), `newContactsAddressBook`, `reminderOwner`, `intervalSeconds` per
authority, the last `RunStatus` per authority, and `removedInAndroidSettings`.
Whether sync is on is not stored: Android's `getSyncAutomatically` is the
source of truth. Headless runs await hydration before any `set()` (zustand 5
writes on every `set()`, even before hydration, and would overwrite the stored
preferences).

### Settings sections

Android only (`supportsDeviceSync` in `platform-capabilities.ts` and the
native module present). Settings → Contacts and Settings → Calendar each get a
"Sync to this device" section with a row per signed-in account:

- an on/off switch (reflects `getSyncAutomatically`; "Paused in Android
  settings" when the account exists but the authority is off there; a hint when
  the device's master auto-sync is off);
- a chooser (sheet) for address books or calendars, with personal ones on and
  shared ones off by default, read-only ones marked, and a warning when another
  signed-in account already syncs the same shared collection;
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
- **Disable an authority:** the engine's teardown runs under the run mutex:
  it uploads the authority's dirty, deleted and new items (bounded to 30 s;
  it is not a sync run, so the "disabled" preflight does not stop it), then
  deletes the authority's rows and SyncState. When items could not be uploaded
  (offline, errors), nothing is deleted and the app asks: "N changes made on
  this device haven't reached the server. Turn off anyway?" Only then
  `setSyncEnabled(false)`; when both authorities are off the Android account
  is removed.
- **Logout** (`auth-store.logout`, `logoutAll`, `removeAccount`): the same as
  disabling both, before the credentials go, with the same question when
  changes would be lost.
- **Registry evictions** (the app drops an account on its own, e.g. after an
  `AuthenticationError`): reconciling Android accounts against the registry at
  every engine start and on foreground finds an Android account whose registry
  id is gone. It is not removed: automatic sync is turned off and one
  notification says how many device changes are waiting ("Sign in again").
  Signing in again resumes it; removing it in the app or in Android Settings
  drops it. An empty or unreadable registry is never acted on.
- **Account removed in Android Settings:** detected by the accounts listener
  and on foreground; the store marks it, the switches show off, and the app
  does not recreate the account.
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
  foreground → `requestSync` for that authority, debounced 5 s. A StateChange
  whose state equals the one the engine last recorded is our own echo and is
  skipped.
- **App closed:** while an account has device sync on, its push subscription
  adds `ContactCard`, `AddressBook` (contacts) and `CalendarEvent`, `Calendar`
  (calendar) to `EmailDelivery`, per account. The relay forwards the
  StateChange's `changed` map verbatim (FCM data key `changed`; only its first
  account key is repeated as `accountId`). A native router in the FCM and
  UnifiedPush services walks every account key of `changed`, maps contact and
  calendar types to `requestSync` through the routes JS stored, and starts the
  mail push task only when some account's map has `EmailDelivery`. A guard at
  the top of `pushBackgroundTask` returns for StateChanges without
  `EmailDelivery`, so a contact change can never take the legacy "notify the
  newest unread mail" path.

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
| Server `SetError` on an item | notFound → local delete; forbidden with scheduling → retried without it ("invitations not sent"); forbidden → revert; others → poisoned with back-off, listed in the report | automatic / user fixes the item |
| `stateMismatch` | re-download, retry up to 3 times, then `io` without progress | automatic (back-off) |
| 429 | `delayUntil` = Retry-After | automatic |
| Too many local deletions | `tooManyDeletions` + system notification | user picks delete or undo |
| Empty server on a full reconcile | `safetyAbort`, device untouched | user checks the server; turning sync off and on starts over |
| Edit during an upload | clearing assert fails → DIRTY stays, shadow updated | next run uploads the newer edit |
| JS crash or reload mid-run | task ends without report → soft error | automatic |
| React fails to start (debug without Metro) | boot fault → soft error in ~2 s | automatic |
| Account removed in Settings | providers drop rows; app turns sync off | user turns it on again |
| Logout / turning sync off | pending changes uploaded first; if that fails the user is asked before anything is deleted | — |
| Provider refuses a batch (`assert`/`tooLarge`/`provider`) | per-item retry / split; an item that still fails goes on `stale` and blocks its uploads | automatic, or listed in the report |
| App drops the account from its registry (e.g. after an auth error) | Android account kept, sync off, notification with the number of waiting changes | user signs in again, or removes it |
| Rows written for another server or registry account (SyncState `owner`) | the run stops with `internal` | the app offers to start over after uploading what it can |
| DST-ambiguous start on a recurring event, unrepresentable rule | item poisoned with a reason; device shows it, never uploads its timing | limitation |

## Limits and performance

- JMAP: `maxObjectsInGet/Set` (500 on Stalwart), `maxCallsInRequest` (16),
  `maxConcurrentRequests` (4, shared with the UI: the engine keeps one request
  in flight), `maxSizeRequest` (10 MB; the engine targets 1 MB), queries of at
  most 5000 ids per call, `/changes` pages of 256 (Stalwart caps at 5000),
  cards and events of at most 512 KiB.
- Provider: ≤ 499 ops between yield points, ~300 KB per `applyBatch`, photos in
  their own batch; 50 raw contacts or 50 events per chunk.
- JS thread: a `setTimeout(0)` yield between chunks, so the UI keeps rendering
  when the app is open; JSON crosses the bridge as strings.
- Time: 9.5 min per run (2.5 min expedited), checkpoints between chunks,
  continuation through `fullSyncRequested`.

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
- The user's own address for "me" and `OWNER_ACCOUNT`: the session login when
  it is an email address, else the first identity's address; aliases from
  identities also count as "me".

Known limitations:

- Google Contacts may not show or edit third-party accounts (closed source;
  DAVx5 reports the same); AOSP-based and Fossify Contacts do.
- Fossify Contacts re-inserts rows on save: a field or entry it does not model
  (a second nickname or organization, a department, a label) is kept on the
  server, but an entry deleted or a field cleared in Fossify is not deleted or
  cleared on the server. Fossify Calendar's rule edits upload only in the parts
  its editor models.
- Android shows extra instances for BYSETPOS rules other than monthly-BYDAY,
  and none for a daily series older than about 5.5 years (AOSP's 2000-period
  expansion cap).
- Rules with `rscale`/`skip`/leap months: shown approximately, timing never
  uploaded. `EXRULE` is not supported by Stalwart.
- Recurring events whose start or override falls in a DST overlap cannot be
  uploaded (Stalwart drops ambiguous local times).
- A single occurrence that Stalwart holds only as an instance (no master) is
  shown but read-only.
- Moving an event to a calendar of another JMAP account uploads as a create in
  the target account and a destroy in the source (a new uid; participants are
  notified accordingly).
- Descriptions over 64 KB are shown truncated and are not uploaded when edited.
- A shared address book or calendar that two signed-in accounts can both see
  appears once per account when both sync it (each Android account holds its
  own copy).
- Floating events follow the device zone; alerts relative to the end, absolute
  alerts and alerts after the start are kept on the server but not shown.
- Photos travel as 512 px JPEG `data:` URIs; a larger original is replaced by
  its scaled copy only when the user changes the photo on the device.

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
