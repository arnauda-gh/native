// Changes a widget button made that the stored snapshot does not show yet.
// The snapshot holds what the server last said; these are laid over it when
// a widget draws, so a refresh that read the server before the change landed
// cannot bring an archived message back, and a change the server refused is
// undone by dropping it rather than by hoping the next refresh gets through.
//
// An op is pending until the server answers, then done: it stays until a
// refresh that started after the server took it has replaced the data it
// covers (mail, or the calendar/tasks part that only some refreshes load).

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WidgetSnapshot } from './snapshot';

export const PENDING_KEY = 'widgets:pending:v1';

export type PendingChange =
  | { kind: 'removeMail'; id: string }
  | { kind: 'markRead'; id: string }
  | { kind: 'rsvp'; id: string; serverId: string; status: 'accepted' | 'tentative' | 'declined' }
  | { kind: 'task'; id: string; done: boolean };

export interface PendingOp {
  /** Unique per tap. */
  key: string;
  change: PendingChange;
  /** When the tap was made. */
  at: number;
  /** When the server took the change; absent while it is in flight. */
  doneAt?: number;
}

export interface PendingState {
  ops: PendingOp[];
}

/** A done op the next refreshes never confirmed is dropped after this long. */
export const DONE_TTL_MS = 30 * 60 * 1000;
/** An op still in flight after this long belongs to a task that died. */
export const IN_FLIGHT_TTL_MS = 2 * 60 * 1000;

export function emptyPending(): PendingState {
  return { ops: [] };
}

export async function loadPending(): Promise<PendingState> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PendingState>) : null;
    return { ops: Array.isArray(parsed?.ops) ? parsed!.ops : [] };
  } catch {
    return emptyPending();
  }
}

export async function savePending(state: PendingState): Promise<void> {
  await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(state));
}

const isMail = (c: PendingChange) => c.kind === 'removeMail' || c.kind === 'markRead';

/** Drop what has expired: in-flight ops of a task that died, done ops no refresh confirmed. */
export function expire(state: PendingState, now: number): PendingState {
  return {
    ...state,
    ops: state.ops.filter((o) => (o.doneAt ? now - o.doneAt < DONE_TTL_MS : now - o.at < IN_FLIGHT_TTL_MS)),
  };
}

/**
 * After a refresh that started at `startedAt` was stored: the done ops it
 * covers are now part of the snapshot. Mail is always refreshed; calendar and
 * tasks only when `appData` is set.
 */
export function confirmedBy(ops: PendingOp[], startedAt: number, appData: boolean): PendingOp[] {
  return ops.filter((o) => !(o.doneAt !== undefined && o.doneAt < startedAt && (appData || isMail(o.change))));
}

/** The snapshot as the widgets should show it: the stored one with every op applied. */
export function applyPending(s: WidgetSnapshot, ops: PendingOp[]): WidgetSnapshot {
  if (ops.length === 0) return s;
  const next: WidgetSnapshot = {
    ...s,
    mail: {
      ...s.mail,
      folders: s.mail.folders.map((f) => ({ ...f })),
      inbox: [...s.mail.inbox],
      unified: [...s.mail.unified],
      starred: [...s.mail.starred],
    },
    calendar: { ...s.calendar, events: [...s.calendar.events], invitations: [...s.calendar.invitations] },
    tasks: { ...s.tasks, items: [...s.tasks.items] },
  };
  for (const { change } of ops) {
    switch (change.kind) {
      case 'removeMail': {
        const removed = next.mail.inbox.find((m) => m.id === change.id);
        const drop = <T extends { id: string }>(list: T[]) => list.filter((m) => m.id !== change.id);
        next.mail.inbox = drop(next.mail.inbox);
        next.mail.unified = drop(next.mail.unified);
        next.mail.starred = drop(next.mail.starred);
        const inbox = next.mail.folders.find((f) => f.role === 'inbox');
        if (inbox && removed) {
          inbox.total = Math.max(0, inbox.total - 1);
          if (removed.unread) inbox.unread = Math.max(0, inbox.unread - 1);
        }
        break;
      }
      case 'markRead': {
        const hit = next.mail.inbox.find((m) => m.id === change.id);
        const inbox = next.mail.folders.find((f) => f.role === 'inbox');
        if (hit?.unread && inbox) inbox.unread = Math.max(0, inbox.unread - 1);
        const read = <T extends { id: string; unread: boolean }>(list: T[]) =>
          list.map((m) => (m.id === change.id && m.unread ? { ...m, unread: false } : m));
        next.mail.inbox = read(next.mail.inbox);
        next.mail.unified = read(next.mail.unified);
        next.mail.starred = read(next.mail.starred);
        break;
      }
      case 'rsvp':
        next.calendar.invitations = next.calendar.invitations.filter(
          (i) => i.id !== change.id && i.serverId !== change.serverId,
        );
        next.calendar.events = next.calendar.events.map((e) =>
          (e.serverId === change.serverId && e.myStatus ? { ...e, myStatus: change.status } : e));
        break;
      case 'task':
        next.tasks.items = next.tasks.items.map((t) => (t.id === change.id ? { ...t, done: change.done } : t));
        break;
    }
  }
  return next;
}
