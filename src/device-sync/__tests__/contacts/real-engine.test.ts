// The contacts planner driven by the engine (fake providers, fake Stalwart):
// cases that only show end to end, over several runs. The planner's rules
// themselves are tested in the other files of this folder.

import { describe, expect, it } from 'vitest';
import { MimeType } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import { addServerCards, CONTACTS_AUTHORITY, createHarness, type Harness } from '../engine/harness';

function real(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const h = createHarness(options);
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

function memberships(h: Harness, rawContactId: number) {
  return h.device.rows('data').filter((d) => Number(d.raw_contact_id) === rawContactId && d.mimetype === MimeType.GROUP_MEMBERSHIP);
}

/** An address book of the personal account that this device does not sync. */
function unsyncedBook(h: Harness, name = 'Archive'): string {
  const id = h.server.addAddressBook('a', { name });
  h.prefs.contactsSelection[`a/${id}`] = false;
  return id;
}

describe('contacts through the engine', () => {
  it('keeps a card deleted on the device that the server meanwhile also filed in an unsynced book', async () => {
    const h = real();
    const archive = unsyncedBook(h);
    const [ada] = addServerCards(h, ['Ada Lovelace']);
    expect((await h.run()).outcome).toBe('ok');

    h.device.user.deleteContact(h.contactNamed('Ada Lovelace')!.id);
    h.server.serverUpdate('ContactCard', 'a', ada, { [`addressBookIds/${archive}`]: true });
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { deleted: 1 } } });
    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ addressBookIds: { [archive]: true } });
    expect(h.contacts()).toEqual([]);
  });

  it('keeps a group deleted on the device that the server meanwhile also filed in an unsynced book', async () => {
    const h = real();
    const archive = unsyncedBook(h);
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, addressBookIds: { [h.book]: true } });
    expect((await h.run()).outcome).toBe('ok');

    const row = h.device.rows('groups').find((g) => g.sourceid === `a/${group}`)!;
    h.device.user.deleteGroup(Number(row._id));
    h.server.serverUpdate('ContactCard', 'a', group, { [`addressBookIds/${archive}`]: true });
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { deleted: 1 } } });
    expect(h.server.get('ContactCard', 'a', group)).toMatchObject({ addressBookIds: { [archive]: true } });
    expect(h.device.rows('groups')).toEqual([]);
  });

  it('puts back a membership in a group of another account, so no change waits for ever', async () => {
    const h = real({ accounts: 'withShared' });
    const book = h.server.all('AddressBook', 'team')[0].id as string;
    h.prefs.contactsSelection[`team/${book}`] = true;
    const team = h.server.addCard('team', { uid: 'g-team', kind: 'group', name: { full: 'Team' }, addressBookIds: { [book]: true } });
    addServerCards(h, ['Ada Lovelace']);
    expect((await h.run()).outcome).toBe('ok');

    const ada = h.contactNamed('Ada Lovelace')!.id;
    h.device.user.addToGroup(ada, Number(h.device.rows('groups').find((g) => g.sourceid === `team/${team}`)!._id));
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { skipped: 1 } });
    expect(h.contactNamed('Ada Lovelace')).toMatchObject({ dirty: false });
    expect(memberships(h, ada)).toEqual([]);
    expect(h.server.get('ContactCard', 'team', team)?.members).toBeUndefined();
    // Turning sync off finds nothing waiting.
    expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 0 });
  });
});
