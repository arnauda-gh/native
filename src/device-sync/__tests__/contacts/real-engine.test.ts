// The contacts planner driven by the engine (fake providers, fake Stalwart):
// cases that only show end to end, over several runs. The planner's rules
// themselves are tested in the other files of this folder.

import { describe, expect, it } from 'vitest';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import { addServerCards, createHarness, type Harness } from '../engine/harness';

function real(): Harness {
  const h = createHarness();
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
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
});
