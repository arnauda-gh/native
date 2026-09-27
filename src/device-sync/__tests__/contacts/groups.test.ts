import { describe, expect, it } from 'vitest';
import { Data, Groups, MimeType } from '../../android-columns';
import type { ContactCardWire, OpGroup, UploadPlan } from '../../planner';
import { appleCard, googleCard } from './fixtures';
import { Harness, JMAP } from './harness';

function actionsOf(plan: UploadPlan<ContactCardWire>) {
  if (plan.kind !== 'upload') throw new Error(`expected an upload, got ${plan.kind}`);
  return plan.actions;
}

function opsOf(plan: UploadPlan<ContactCardWire>): OpGroup {
  if (plan.kind === 'upload' || plan.kind === 'skip') throw new Error(`expected ops, got ${plan.kind}`);
  return plan.ops;
}

async function localGroup(h: Harness, groupId: string) {
  const g = (await h.groups()).find((x) => x.sourceId === `${JMAP}/${groupId}`);
  if (!g) throw new Error(`no group row for ${groupId}`);
  return g;
}

/** A group card holding Anna (apple card), both on the device. */
async function withGroup(members: Record<string, boolean> = { [appleCard().uid as string]: true }) {
  const h = new Harness();
  const gid = h.addCard({ uid: 'urn:uuid:group-friends', kind: 'group', name: { full: 'Friends' }, members });
  await h.download(gid);
  const { id, rawId } = await h.seed(appleCard());
  return { h, gid, id, rawId };
}

describe('contacts groups: download', () => {
  it('writes a group card as a visible group row, and nothing for its echo', async () => {
    const { h, gid } = await withGroup();
    const row = h.device.rows('groups', 'sourceid = ?', [`${JMAP}/${gid}`])[0];
    expect(row).toMatchObject({ [Groups.TITLE]: 'Friends', [Groups.GROUP_VISIBLE]: 1, [Groups.DIRTY]: 0 });
    const plan = h.planner.planGroupDownload(h.card(gid), await localGroup(h, gid), h.ctx);
    expect(plan).toMatchObject({ effect: 'none', ops: { ops: [] } });
  });

  it('writes one membership row per group card that lists the contact', async () => {
    const { h, gid, rawId } = await withGroup();
    expect(h.membershipGroups(rawId)).toEqual([`${JMAP}/${gid}`]);
    const local = await h.contact(rawId);
    expect(local.rows.find((r) => r.mimetype === MimeType.GROUP_MEMBERSHIP)?.key).toBe(`members:${JMAP}/${gid}`);
    expect(local.shadow?.['~memberOf']).toEqual([`${JMAP}/${gid}`]);
  });

  it('leaves memberships alone when the engine has no group index', async () => {
    const h = new Harness();
    h.groupIndex = false;
    const gid = h.addCard({ uid: 'urn:uuid:g', kind: 'group', name: { full: 'G' }, members: { [appleCard().uid as string]: true } });
    await h.download(gid);
    const { rawId } = await h.seed(appleCard());
    expect(h.membershipGroups(rawId)).toEqual([]);
    expect((await h.contact(rawId)).shadow?.['~memberOf']).toBeUndefined();
  });

  it('follows the group card when members change on the server (a re-plan of the unchanged contact)', async () => {
    const { h, gid, rawId } = await withGroup();
    h.server.serverUpdate('ContactCard', JMAP, gid, { [`members/${appleCard().uid as string}`]: null });
    await h.download(gid);
    let local = await h.contact(rawId);
    await h.applyOk(h.planner.planDownload(local.shadow!, local, h.ctx).ops);
    expect(h.membershipGroups(rawId)).toEqual([]);
    h.server.serverUpdate('ContactCard', JMAP, gid, { members: { [appleCard().uid as string]: true } });
    await h.download(gid);
    local = await h.contact(rawId);
    await h.applyOk(h.planner.planDownload(local.shadow!, local, h.ctx).ops);
    expect(h.membershipGroups(rawId)).toEqual([`${JMAP}/${gid}`]);
  });

  it('lets the server win when both sides renamed the group', async () => {
    const { h, gid } = await withGroup();
    const g = await localGroup(h, gid);
    h.device.user.updateGroup(g.groupId, { [Groups.TITLE]: 'Mates' });
    h.server.serverUpdate('ContactCard', JMAP, gid, { 'name/full': 'Pals' });
    const plan = h.planner.planGroupDownload(h.card(gid), await localGroup(h, gid), h.ctx);
    expect(plan.conflicts).toBe(1);
    await h.applyOk(plan.ops);
    expect((await localGroup(h, gid)).title).toBe('Pals');
  });
});

describe('contacts groups: membership edits', () => {
  it('adds the contact to a group card with `members/<uid>: true`, keeping it dirty until the server has it', async () => {
    const h = new Harness();
    const other = h.addCard({ uid: 'urn:uuid:g2', kind: 'group', name: { full: 'Work' }, members: { 'urn:uuid:someone': true } });
    await h.download(other);
    const { rawId } = await h.seed(appleCard());
    const g = await localGroup(h, other);
    h.device.user.addToGroup(rawId, g.groupId);
    expect((await h.upload(rawId)).kind).toBe('clean');
    expect(h.dirty(rawId)).toBe(true);
    const actions = h.planner.planMembershipUploads([await h.contact(rawId)], await h.groups(), h.ctx);
    expect(actions).toEqual([{ kind: 'update', id: other, patch: { [`members/${appleCard().uid as string}`]: true } }]);
    h.send(actions);
    const accepted = h.planner.planGroupAccepted(g, h.card(other), h.ctx);
    await h.applyOk(accepted.ops);
    await h.upload(rawId);
    expect(h.dirty(rawId)).toBe(false);
    expect(h.planner.planMembershipUploads([await h.contact(rawId)], await h.groups(), h.ctx)).toEqual([]);
  });

  it('sends the whole map for the first member of an empty group', async () => {
    const h = new Harness();
    const empty = h.addCard({ uid: 'urn:uuid:g3', kind: 'group', name: { full: 'Empty' } });
    await h.download(empty);
    const { rawId } = await h.seed(appleCard());
    h.device.user.addToGroup(rawId, (await localGroup(h, empty)).groupId);
    const actions = h.planner.planMembershipUploads([await h.contact(rawId)], await h.groups(), h.ctx);
    expect(actions).toEqual([{ kind: 'update', id: empty, patch: { members: { [appleCard().uid as string]: true } } }]);
  });

  it('removes the contact with `members/<uid>: null` when its membership row was deleted in place', async () => {
    const { h, gid, rawId } = await withGroup({ [appleCard().uid as string]: true, 'urn:uuid:someone': true });
    const membership = (await h.contact(rawId)).rows.find((r) => r.mimetype === MimeType.GROUP_MEMBERSHIP)!;
    h.device.user.deleteData(membership.id);
    const actions = h.planner.planMembershipUploads([await h.contact(rawId)], await h.groups(), h.ctx);
    expect(actions).toEqual([{ kind: 'update', id: gid, patch: { [`members/${appleCard().uid as string}`]: null } }]);
  });

  it('uploads nothing when an editor re-inserted the same memberships without keys', async () => {
    const { h, rawId } = await withGroup();
    const rows = h.device.rows('data', 'raw_contact_id = ?', [rawId]).filter((r) => r[Data.MIMETYPE] === MimeType.GROUP_MEMBERSHIP);
    h.device.user.fossifySave(rawId, null, rows.map((r) => ({ [Data.MIMETYPE]: MimeType.GROUP_MEMBERSHIP, data1: r.data1 })));
    expect(h.planner.planMembershipUploads([await h.contact(rawId)], await h.groups(), h.ctx)).toEqual([]);
  });

  it('does not take a server-side addition for a local removal while the contact is dirty', async () => {
    const { h, gid } = await withGroup({});
    const { rawId } = await h.seed(googleCard());
    h.device.user.updateData(h.rowsByKey(rawId)['phones:k1']._id as number, { data1: '0171 999' });
    h.server.serverUpdate('ContactCard', JMAP, gid, { members: { [googleCard().uid as string]: true } });
    await h.download(gid);
    const local = await h.contact(rawId);
    await h.applyOk(h.planner.planDownload(local.shadow!, local, h.ctx).ops);
    expect(h.membershipGroups(rawId)).toEqual([`${JMAP}/${gid}`]);
    expect(h.planner.planMembershipUploads([await h.contact(rawId)], await h.groups(), h.ctx)).toEqual([]);
  });
});

describe('contacts groups: device edits of groups', () => {
  it('uploads a rename as `name/full`', async () => {
    const { h, gid } = await withGroup();
    const g = await localGroup(h, gid);
    h.device.user.updateGroup(g.groupId, { [Groups.TITLE]: 'Close friends' });
    const plan = h.planner.planGroupUpload(await localGroup(h, gid), h.ctx);
    expect(plan).toEqual({ kind: 'upload', actions: [{ kind: 'update', id: gid, patch: { 'name/full': 'Close friends' } }] });
    h.send(actionsOf(plan));
    const accepted = h.planner.planGroupAccepted(await localGroup(h, gid), h.card(gid), h.ctx);
    await h.applyOk(accepted.ops);
    expect(await localGroup(h, gid)).toMatchObject({ dirty: false, title: 'Close friends' });
    expect(h.planner.planGroupDownload(h.card(gid), await localGroup(h, gid), h.ctx).effect).toBe('none');
  });

  it('claims and creates a group made on the device', async () => {
    const h = new Harness();
    const groupId = h.device.user.insertGroup('usera@example.org', 'Book club');
    const decode = async () => (await h.groups()).find((g) => g.groupId === groupId)!;
    const claim = h.planner.planGroupUpload(await decode(), h.ctx);
    expect(claim.kind).toBe('claim');
    await h.applyOk(opsOf(claim));
    const pending = (await decode()).pending!;
    const plan = h.planner.planGroupUpload(await decode(), h.ctx);
    expect(plan).toEqual({
      kind: 'upload',
      actions: [{
        kind: 'create', uid: pending.uid, collectionId: h.book,
        object: { '@type': 'Card', version: '1.0', uid: pending.uid, kind: 'group', addressBookIds: { [h.book]: true }, name: { full: 'Book club' } },
      }],
    });
    const id = h.send(actionsOf(plan))!;
    await h.applyOk(h.planner.planGroupAccepted(await decode(), h.card(id), h.ctx).ops);
    expect(await decode()).toMatchObject({ sourceId: `${JMAP}/${id}`, dirty: false, pending: null });
  });

  it('destroys a group deleted on the device', async () => {
    const { h, gid } = await withGroup();
    h.device.user.deleteGroup((await localGroup(h, gid)).groupId);
    expect(h.planner.planGroupUpload(await localGroup(h, gid), h.ctx)).toEqual({
      kind: 'upload', actions: [{ kind: 'destroy', id: gid, uid: 'urn:uuid:group-friends' }],
    });
  });

  it('reverts a rename of a read-only group', async () => {
    const { h, gid } = await withGroup();
    h.readOnlyBooks.add(h.book);
    const g = await localGroup(h, gid);
    h.device.user.updateGroup(g.groupId, { [Groups.TITLE]: 'Mine now' });
    const plan = h.planner.planGroupUpload(await localGroup(h, gid), h.ctx);
    expect(plan.kind).toBe('revert');
    await h.applyOk(opsOf(plan));
    expect(await localGroup(h, gid)).toMatchObject({ title: 'Friends', dirty: false });
  });

  it('deletes the group row for a server delete', async () => {
    const { h, gid, rawId } = await withGroup();
    await h.applyOk(h.planner.planGroupLocalDelete(await localGroup(h, gid)));
    expect(h.device.rows('groups', 'sourceid = ?', [`${JMAP}/${gid}`])).toEqual([]);
    expect(h.membershipGroups(rawId)).toEqual([]);
  });
});
