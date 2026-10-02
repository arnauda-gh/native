// Buttons that act without opening the app: archive / delete / next on the
// triage card, RSVP on the invitation card, ticking a task. Each one lays its
// change over the stored data at once (./state.ts) so every widget redraws
// without waiting, then makes the JMAP call. A change the server took stays
// laid over the data until a refresh has caught up with it; one that failed
// is dropped again, which shows the data as the server last described it.

import { jmapClient } from '../api/jmap-client';
import type { JMAPClient } from '../api/jmap-client';
import { refreshSnapshot, singletonServes } from './build';
import { markRead, moveTo, openClient, rsvp, setTaskDone } from './jmap';
import { loadLocal, saveLocal } from './local-state';
import type { PendingChange } from './pending';
import { redrawAll } from './render';
import { serial } from './serial';
import { currentView, settle, track } from './state';

async function clientFor(registryAccountId: string | null | undefined): Promise<JMAPClient | null> {
  if (!registryAccountId) return null;
  if (singletonServes(registryAccountId)) return jmapClient;
  return openClient(registryAccountId);
}

/** Lay `change` over the data, run `call`, and keep or drop the change by its answer. */
async function apply(name: string, change: PendingChange, call: () => Promise<boolean>): Promise<boolean> {
  const key = await track(change);
  await redrawAll();
  let ok = false;
  try {
    ok = await call();
  } catch (err) {
    console.warn(`[widgets] ${name} failed`, err);
  }
  if (!ok) console.warn(`[widgets] ${name} was not applied on the server`);
  await settle(key, ok);
  await redrawAll();
  // Catch up with the server: confirms a change that went through and picks
  // up whatever else changed. Offline this fails quickly and keeps the data.
  await refreshSnapshot({ after: 'change' });
  await redrawAll();
  return ok;
}

type Data = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The triage card's message after `id`, among what the widget shows now. */
async function moveTriagePointer(widgetId: number, id: string): Promise<void> {
  const view = await currentView();
  const unread = view.mail.inbox.filter((m) => m.unread);
  const index = unread.findIndex((m) => m.id === id);
  const next = index >= 0 ? unread[index + 1] ?? unread[index - 1] : undefined;
  await serial(async () => saveLocal(widgetId, { ...(await loadLocal(widgetId)), triageId: next?.id ?? null }));
}

export async function handleWidgetAction(name: string, data: Data, widgetId: number): Promise<void> {
  switch (name) {
    case 'refresh':
      await refreshSnapshot({ after: 'change' });
      await redrawAll();
      return;

    case 'triageNext': {
      const view = await currentView();
      const unread = view.mail.inbox.filter((m) => m.unread);
      if (unread.length === 0) return;
      const index = unread.findIndex((m) => m.id === data.id);
      const next = unread[(index + 1) % unread.length];
      await serial(async () => saveLocal(widgetId, { ...(await loadLocal(widgetId)), triageId: next.id }));
      await redrawAll();
      return;
    }

    case 'archive':
    case 'trash':
    case 'markRead': {
      const id = str(data.id);
      if (!id) return;
      // The triage card moves on to the next unread message, not back to
      // the first one.
      if (name !== 'markRead') await moveTriagePointer(widgetId, id);
      const accountId = str(data.accountId);
      const jmapAccountId = str(data.jmapAccountId);
      await apply(name, name === 'markRead' ? { kind: 'markRead', id } : { kind: 'removeMail', id }, async () => {
        const client = await clientFor(accountId);
        if (!client) return false;
        return name === 'markRead'
          ? markRead(client, id, jmapAccountId)
          : moveTo(client, id, name, jmapAccountId);
      });
      return;
    }

    case 'rsvp': {
      const id = str(data.id);
      const status = data.status;
      if (!id || (status !== 'accepted' && status !== 'tentative' && status !== 'declined')) return;
      const before = await currentView();
      const invitation = before.calendar.invitations.find((i) => i.id === id);
      if (!invitation) return;
      await apply('rsvp', { kind: 'rsvp', id, serverId: invitation.serverId, status }, async () => {
        const client = await clientFor(before.activeAccountId);
        return !!client && rsvp(client, invitation.serverId, invitation.participantId, status, invitation.jmapAccountId);
      });
      return;
    }

    case 'toggleTask': {
      const id = str(data.id);
      if (!id) return;
      const before = await currentView();
      const task = before.tasks.items.find((t) => t.id === id);
      if (!task) return;
      const done = !task.done;
      await apply('task toggle', { kind: 'task', id, done }, async () => {
        const client = await clientFor(before.activeAccountId);
        if (!client || !(await setTaskDone(client, task.serverId, done, task.jmapAccountId))) return false;
        // In the live app the snapshot's tasks come from the calendar store,
        // which did not see this change; reload it before the refresh that
        // follows reads it, or that refresh would undo the tick.
        if (client === jmapClient) {
          const { useCalendarStore } = require('../stores/calendar-store') as typeof import('../stores/calendar-store');
          await useCalendarStore.getState().fetchTasks().catch(() => undefined);
        }
        return true;
      });
      return;
    }

    default:
      console.warn(`[widgets] unknown action ${name}`);
  }
}
