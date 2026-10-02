# Android widgets: verification checklist

Every tap target of the 32 Android home-screen widgets (`src/widgets/`), how
it was tested on the emulator, and what happened. Started for the report
"widget actions sometimes don't work" (#52 follow-up).

## Rig

- Emulator `Bulwark_Pixel7_API35` (Pixel 7, Android 15, x86_64), Pixel
  launcher, release APK built with `-PreactNativeArchitectures=x86_64`.
- Servers: the standing test servers, Stalwart 0.16 (`stalwart-test`) and
  1.0 (`stalwart-test-v1`), reached through a logging reverse proxy that
  records every JMAP method, `notUpdated`/`notCreated` and errors, and can
  delay or fail chosen methods on request.
- Accounts: `usera@example.org` (password) and `userb@example.org` (OAuth
  through Stalwart's own authorization server) signed in at once. Both are
  members of the `team@` group; `usera`'s calendar is shared with `userb`.
  Extra test data: tasks for both, invitations each way through server-side
  scheduling.
- Placed: Triage, Tasks, Invitations (others in phase 3).

## States

| Code | State | How |
|---|---|---|
| FG | App on screen when the link arrives | `am start` of the link while the app is in front |
| BG | App backgrounded, JS runtime alive | Home after using the app |
| COLD | Process dead | `adb root`, `kill -9 <pid>` (not `am kill`, not `force-stop`) |
| OFF | Offline | `cmd connectivity airplane-mode enable` |
| ACC2 | Item belongs to the non-active account | the other account active in the app |
| SHARED | Item in a shared or group account | `usera`'s calendar seen by `userb` |
| DBL | Two taps in quick succession | `input tap` twice, 150 ms and 1–1.5 s apart |
| UPD | Tap while a refresh is running | proxy delays `Email/set` by 4 s, second tap meanwhile |

A widget tap cannot happen with the app in front, so FG applies to deep
links only. Links were opened with `am start -a VIEW -f 0x10000000`, which is
exactly what the widget provider does (`RNWidgetProvider.openUri`); the
widget's own Reply, card and event taps were also tapped on the launcher.

## Phase 1 results (before fixes, Stalwart 0.16)

### Background actions

| Action | Widgets | BG | COLD | OFF | ACC2 | DBL | UPD | Notes |
|---|---|---|---|---|---|---|---|---|
| archive | Triage | pass | pass | **fail** | n/a | **fail** | **fail** | see A1, A2, A3 |
| trash | Triage | pass | pass | **fail** | n/a | **fail** | **fail** | same code path as archive |
| triageNext | Triage | pass | pass | pass | n/a | pass | pass | local only |
| rsvp | Invitations | pass | pass | **fail** | **fail** | **fail** | **fail** | A1, A3, A4, A5 |
| toggleTask | Tasks, Today overview | pass | pass | **fail** | **fail** | **fail** | **fail** | A1, A3, A4, A5, A6 |
| markRead | (no button uses it) | – | – | – | – | – | – | kept for the API |
| any button | all | pass* | pass* | – | – | – | – | *on this emulator; A0 |

### Deep links (`links.*` in `src/widgets/clicks.ts`)

| Link | Used by | FG | BG | COLD | OFF | ACC2 | Notes |
|---|---|---|---|---|---|---|---|
| inbox | Inbox, Unread count, Folder counts, Tag, Attachments, Mail and next, Today overview | pass | pass | pass | pass | n/a | |
| message | Inbox/Starred/All accounts rows, Latest message, Triage card, Mail and next, Attachments | pass | pass | pass | **fail** | pass online | L4 |
| reply | Triage | **fail** | **fail** | **fail** | **fail** | **fail** | L1 |
| draft | Last draft | pass | pass | pass | **fail** | pass online | L4 |
| unified (all / starred / role) | All accounts, Starred, Folder counts, Last draft | pass | pass | pass | not run | n/a | |
| scheduled | Outbox, Folder counts | pass | pass | pass | not run | n/a | |
| search (empty / query) | Inbox, Search mail, Favourite people | pass | pass | pass | not run | n/a | empty search opens the list without focusing the field |
| compose (plain) | Inbox, Last draft | pass | pass | pass | pass | n/a | |
| compose with to + subject | Birthdays "Send wishes", Up next "Running late" | **fail** | **fail** | **fail** | **fail** | n/a | L2 |
| calendar | all calendar and plans widgets | pass | pass | pass | **crash** | n/a | L3 |
| event | Week, Month, Today, Next event, Up next, Countdown, Invitations, Mail and next | **fail** | pass | pass | **crash** | **fail** | L3, L5 |
| contacts | Shortcuts, Favourite people, Birthdays | pass | pass | pass | not run | n/a | |
| files | Shortcuts, Recent files | pass | pass | pass | not run | n/a | |
| settings/vacation, /account, /calendar | Vacation, Storage, Free time, Tasks (off) | pass | pass | pass | not run | n/a | |
| video URL | Up next "Join" | – | – | – | – | – | external https link, opens the browser |

### Refresh

| Case | Result | Notes |
|---|---|---|
| App goes to the background | **fail** (sometimes) | R1 |
| Account switched in the app | **fail** | R1: widgets kept the previous account until the next app start |
| Cold periodic update | pass for mail | R2: calendar, tasks, files, scheduled stay as last loaded by the app |
| Back online after an offline tap | **fail** | A1: nothing brings the change back until the app or a 30-minute update runs |

## Causes found

- **A0. Buttons silently dead on fast phones.** The widget library registers
  every button's `PendingIntent` with `requestCode = (int)
  System.currentTimeMillis()` and `FLAG_CANCEL_CURRENT`. All buttons of one
  widget share the same action and component, so two buttons registered in
  the same millisecond get the same identity and the second registration
  cancels the first: that button then does nothing at all. On the emulator
  each registration takes 3–10 ms (measured from the request codes in
  `dumpsys activity intents`), so every button survived; a current phone
  makes the binder call in well under a millisecond, which makes the dead
  button depend on timing — "sometimes". The cancelled-then-recreated
  records also pile up (227 for three widgets after an hour of testing).
- **A1. Offline or failed calls look like they worked.** The action edits
  the stored snapshot first and relies on the next refresh to undo a failed
  call. Offline that refresh fails too and returns the edited snapshot, so
  an archive that never reached the server shows as done; a cold refresh
  never reloads calendar or tasks, so a refused RSVP or task change is never
  undone either. Failures are only `console.warn`ed.
- **A2. A fast second tap repeats the first.** Two taps 150 ms apart both
  archived `d2aaaaa3`: the second tap hits the buttons of the old drawing,
  which still name the first message. Harmless for archive; for task ticks
  the code would flip the task back, because `toggleTask` inverts whatever
  the stored snapshot says instead of carrying the state the user saw.
- **A3. A refresh brings back a message just archived.** Each tap is its own
  headless task in the same runtime; they interleave at every await. With
  `Email/set` delayed 4 s, tap 1's refresh read the server before tap 2's
  archive landed, was stored anyway (it started after tap 2's local edit, so
  `noteLocalChange` did not catch it) and redrew the archived message
  (`baaaaaai`, log 08:44:19), until tap 2's own refresh removed it again.
  Separately, load–edit–save of the snapshot is not serialized, so two
  concurrent edits can drop one, and redraws of different snapshots can land
  out of order. In one run the second tap archived a message the card was
  not showing.
- **A4. RSVP and task ticks go to the wrong account after a switch.** They
  pick the client from `snapshot.activeAccountId` and look the item up by id
  in the current snapshot, not from the tap's own data. JMAP ids are small
  per-account sequences (`e`, `f`, `h1kbleaaaaaj`), so a tap on a drawing
  made before an account switch can match another account's task or event
  with the same id. Not reproduced on the device (the window between the
  stored refresh and the redraw is short); follows from the code.
- **A5. Nothing tells the user.** See A1.
- **A6. The task tick target is 22 dp.** A tap on the task's title or a few
  dp beside the circle does nothing.
- **Lead 2 (`target` lacks `widgetId`) is ruled out**: the logged click data
  of Archive/Delete is `{"id":…,"widgetId":3,"accountId":…}`.
- **Lead 4 (credentials in a cold runtime)**: the password account restores
  and acts from a cold start (archive, task tick). The OAuth account with an
  access token that expired while the app was dead is checked in phase 2.
- **Lead 5 (`progressUpdated`)** is ruled out: the widget's task update has
  carried no `progressUpdated` since the B12 fix, and both 0.16 and 1.0
  accept it (`updated`, no `notUpdated`).
- **R1. The refresh on going to the background often never runs.** With an
  account switched in the app and Home pressed, no refresh request reached
  the proxy and the widgets kept the old account's mail.
- **R2. Cold refreshes skip calendar and tasks.** Only mail has JMAP code of
  its own; the rest needs the app's stores, which only run with the UI.
- **L1. Widget Reply never opens the composer.** The reader opens on the
  message but the composer does not follow, in every state.
- **L2. "Send wishes" loses its subject.** `parseDeepLink` takes the
  subject from the mailto parser, which returns an empty string rather than
  nothing, so the link's own `subject` is never used.
- **L3. Calendar links crash the app offline.** On an offline cold start the
  Calendar tab mounts `CalendarShareSheet`, whose list of people to share
  with calls `ownPrincipalId()` while rendering; with no session that throws
  "Not authenticated - call connect() first" and the app closes.
- **L4. Message links for the other account fail offline.** The link
  switches accounts first, which needs the server; offline the switch fails
  and the app shows "Couldn't open this".
- **L5. Event links carry no account.** With the other account active, an
  event link opens the Calendar tab and nothing else (or, with an id that
  exists in both accounts, the wrong event). In the foreground the event
  link landed on the Inbox.
