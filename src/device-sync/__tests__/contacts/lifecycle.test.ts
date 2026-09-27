import { describe, expect, it } from 'vitest';
import { Data, MimeType } from '../../android-columns';
import type { LocalContact } from '../../planner';
import { JPEG, probeCard } from './fixtures';
import { Harness, JMAP } from './harness';

/** The engine's view after every write: a clean contact whose rows the server card describes. */
async function expectSettled(h: Harness, id: string, rawId: number): Promise<LocalContact> {
  const local = await h.contact(rawId);
  expect(local.dirty).toBe(false);
  expect(h.planner.planDownload(h.card(id), local, h.ctx).effect).toBe('none');
  expect(h.planner.planBaselineHeal(local)).toBeNull();
  return local;
}

describe('contacts lifecycle', () => {
  it('settles after device edits, an editor rewrite and server edits in turn', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(probeCard());
    let rows = h.rowsByKey(rawId);

    // Several fields at once in AOSP Contacts.
    h.device.user.updateData(rows.name._id as number, { data2: 'Probert', data1: 'Dr. Probert Person' });
    h.device.user.updateData(rows['emails:zz9']._id as number, { data1: 'home@example.org' });
    h.device.user.updateData(rows['addresses:home']._id as number, { data9: '10117' });
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: MimeType.PHONE, data1: '+49 30 7777', data2: 3 });
    await h.upload(rawId);
    const card = h.card(id);
    expect(card.name).toMatchObject({ full: 'Dr. Probert Person' });
    expect(card.emails!.zz9.address).toBe('home@example.org');
    expect(card.addresses!.home.components).toContainEqual({ kind: 'postcode', value: '10117' });
    expect(Object.values(card.phones!).map((p) => p.number)).toContain('+49 30 7777');
    expect(card.onlineServices).toEqual(probeCard().onlineServices);
    expect(card.notes!.n2).toEqual({ note: 'second note' });
    await expectSettled(h, id, rawId);

    // Fossify rewrites everything but the name; nothing uploads, the rows come back whole.
    rows = h.rowsByKey(rawId);
    h.device.user.fossifySave(rawId, null, Object.values(rows)
      .filter((r) => r[Data.MIMETYPE] === MimeType.EMAIL || r[Data.MIMETYPE] === MimeType.PHONE)
      .map((r) => ({ [Data.MIMETYPE]: r[Data.MIMETYPE], data1: r.data1, data2: r.data2 })));
    expect((await h.upload(rawId)).kind).toBe('clean');
    await expectSettled(h, id, rawId);
    expect(h.rowsByKey(rawId)['organizations:o1|titles:t1,r1'].data5).toBe('R&D');

    // The server edits and removes things.
    h.server.serverUpdate('ContactCard', JMAP, id, { 'nicknames/nk/name': 'Probo', 'links/l1': null, 'addresses/home/components': [{ kind: 'locality', value: 'Hamburg' }] });
    await h.download(id);
    await expectSettled(h, id, rawId);
    rows = h.rowsByKey(rawId);
    expect(rows['nicknames:nk'].data1).toBe('Probo');
    expect(rows['links:l1']).toBeUndefined();
    expect(rows['addresses:home']).toMatchObject({ data7: 'Hamburg', data4: null });
  });

  it('follows Stalwart re-keying the whole card by position, without rewriting a row', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(probeCard());
    const before = h.rowsByKey(rawId);
    h.server.rekeyPositionally(JMAP, id, 'ContactCard');
    const plan = h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx);
    for (const op of plan.ops.ops) {
      if (op.op === 'update' && op.table === 'data') expect(Object.keys(op.values).every((c) => c.startsWith('data_sync'))).toBe(true);
      expect(op.op === 'insert' || op.op === 'delete').toBe(false);
    }
    await h.applyOk(plan.ops);
    const after = h.rowsByKey(rawId);
    expect(after['organizations:k1|titles:k1,k2']._id).toBe(before['organizations:o1|titles:t1,r1']._id);
    expect(after['emails:k2']._id).toBe(before['emails:x/y']._id);
    await expectSettled(h, id, rawId);

    // The next device edit patches the entry under its new key.
    h.device.user.updateData(after['emails:k2']._id as number, { data1: 'slash3@example.org' });
    const upload = h.planner.planUpload(await h.contact(rawId), h.ctx);
    expect(upload).toMatchObject({ kind: 'upload', actions: [{ patch: { 'emails/k2/address': 'slash3@example.org' } }] });
  });

  it('writes a blob-backed photo from the bytes the engine fetched, and nothing for its echo', async () => {
    const h = new Harness();
    h.blobs.set('B1', JPEG);
    const { id, rawId } = await h.seed({ name: { full: 'Blob Photo' }, media: { p: { kind: 'photo', blobId: 'B1', mediaType: 'image/jpeg' } } });
    const photo = h.rowsByKey(rawId)['media:p'];
    expect(h.device.photo(Number(photo.data14))).toBe(JPEG);
    expect((await h.contact(rawId)).shadow?.media).toEqual({ p: { kind: 'photo', blobId: 'B1', mediaType: 'image/jpeg' } });
    await expectSettled(h, id, rawId);
  });

  it('keeps the photo row when the photo bytes could not be fetched, and never reads it as deleted', async () => {
    const h = new Harness();
    h.blobs.set('B1', JPEG);
    const { id, rawId } = await h.seed({ name: { full: 'Blob Photo' }, emails: { e1: { address: 'a@example.org' } }, media: { p: { kind: 'photo', blobId: 'B1' } } });
    const photoRow = h.rowsByKey(rawId)['media:p']._id;
    h.blobs.delete('B1');
    h.server.serverUpdate('ContactCard', JMAP, id, { 'emails/e1/address': 'b@example.org' });
    await h.download(id);
    expect(h.rowsByKey(rawId)['media:p']?._id).toBe(photoRow);
    h.device.user.updateData(h.rowsByKey(rawId)['emails:e1']._id as number, { data1: 'c@example.org' });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toMatchObject({ kind: 'upload', actions: [{ patch: { 'emails/e1/address': 'c@example.org' } }] });
    const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
    expect(plan.kind === 'upload' && Object.keys((plan.actions[0] as { patch: object }).patch)).toEqual(['emails/e1/address']);
  });

  it('heals a baseline the provider stored differently from the prediction', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed({ name: { full: 'Dr. Jane Q. Public' } });
    const name = h.rowsByKey(rawId).name;
    // The real NameSplitter knows titles and middle names; the prediction does not.
    await h.applyOk({ ref: 'split', ops: [{ op: 'update', table: 'data', id: name._id as number, values: { data4: 'Dr.', data2: 'Jane', data5: 'Q.', data3: 'Public' } }] });
    const heal = h.planner.planBaselineHeal(await h.contact(rawId));
    expect(heal?.ops.map((o) => o.op)).toEqual(['assert', 'update']);
    await h.applyOk(heal!);
    await expectSettled(h, id, rawId);
    h.device.user.star(rawId);
    expect((await h.upload(rawId)).kind).toBe('clean');
  });

  it('does not heal a dirty contact: its edit must still count', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.updateData(h.rowsByKey(rawId)['notes:n1']._id as number, { data1: 'edited' });
    expect(h.planner.planBaselineHeal(await h.contact(rawId))).toBeNull();
  });
});
