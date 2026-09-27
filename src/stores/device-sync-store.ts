/**
 * Device sync preferences and status per app account (Android only, #34;
 * docs/device-sync.md, "App integration"). Keyed by `AccountEntry.id`.
 *
 * Whether sync is on is not stored here: Android's sync settings
 * (`getSyncAutomatically` per authority) are the source of truth, so the
 * toggles in Settings → Accounts and the app always agree.
 *
 * Persisted under `device-sync:v1` without the write delay the caches use: a
 * headless sync run may be the only thing alive, and its status must survive
 * the process. Not part of the settings export. A headless run reads and
 * writes it only after `waitForDeviceSyncHydration()`: zustand 5 persists on
 * every `set()`, even before hydration, and would overwrite the stored state.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistStorage } from './persist-storage';
import type {
  AccountSyncPrefs,
  Authority,
  CollectionKey,
  ReminderOwner,
  RunStatus,
} from '../device-sync/types';

/** Periodic sync interval when the user has not picked one: push covers freshness. */
export const DEFAULT_INTERVAL_SECONDS = 3600;

export interface AccountDeviceSync {
  /** Explicit choices only; unlisted collections follow the default (personal on, shared off). */
  contactsSelection: Record<CollectionKey, boolean>;
  calendarSelection: Record<CollectionKey, boolean>;
  /** Where contacts created on the device go; unset = the server's default address book. */
  newContactsAddressBook?: CollectionKey;
  /** Who reminds the user of synced events; null until asked. */
  reminderOwner: ReminderOwner | null;
  /** Periodic sync per authority in seconds; 0 = manual only. */
  intervalSeconds: Partial<Record<Authority, number>>;
  lastRun: Partial<Record<Authority, RunStatus>>;
  /** The Android account name this app account uses. */
  androidAccountName?: string;
  /** Removed in Android Settings: the app shows sync as off and never recreates the account on its own. */
  removedInAndroidSettings?: boolean;
  /**
   * Latest item states the engine synced, per JMAP account and type
   * (`ContactCard`, `CalendarEvent`, …). A StateChange naming the same state is
   * our own echo and triggers no sync.
   */
  knownStates?: Record<string, Record<string, string>>;
}

export function emptyAccountDeviceSync(): AccountDeviceSync {
  return {
    contactsSelection: {},
    calendarSelection: {},
    reminderOwner: null,
    intervalSeconds: {},
    lastRun: {},
  };
}

interface DeviceSyncState {
  accounts: Record<string, AccountDeviceSync>;
  update: (registryId: string, patch: Partial<AccountDeviceSync>) => void;
  recordRunStatus: (registryId: string, authority: Authority, status: RunStatus) => void;
  recordKnownState: (registryId: string, jmapAccountId: string, type: string, state: string) => void;
  forget: (registryId: string) => void;
}

export const useDeviceSyncStore = create<DeviceSyncState>()(
  persist(
    (set) => ({
      accounts: {},
      update: (registryId, patch) =>
        set((s) => ({
          accounts: {
            ...s.accounts,
            [registryId]: { ...(s.accounts[registryId] ?? emptyAccountDeviceSync()), ...patch },
          },
        })),
      recordRunStatus: (registryId, authority, status) =>
        set((s) => {
          const current = s.accounts[registryId] ?? emptyAccountDeviceSync();
          return {
            accounts: {
              ...s.accounts,
              [registryId]: { ...current, lastRun: { ...current.lastRun, [authority]: status } },
            },
          };
        }),
      recordKnownState: (registryId, jmapAccountId, type, state) =>
        set((s) => {
          const current = s.accounts[registryId] ?? emptyAccountDeviceSync();
          const known = current.knownStates ?? {};
          return {
            accounts: {
              ...s.accounts,
              [registryId]: {
                ...current,
                knownStates: { ...known, [jmapAccountId]: { ...(known[jmapAccountId] ?? {}), [type]: state } },
              },
            },
          };
        }),
      forget: (registryId) =>
        set((s) => {
          const { [registryId]: _gone, ...rest } = s.accounts;
          return { accounts: rest };
        }),
    }),
    {
      name: 'device-sync:v1',
      storage: createPersistStorage({ writeDelayMs: 0 }),
      partialize: (state) => ({ accounts: state.accounts }),
    },
  ),
);

/** Resolves once the persisted state has been read (at once when it already was). */
export function waitForDeviceSyncHydration(): Promise<void> {
  if (useDeviceSyncStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useDeviceSyncStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

/** The engine's view of one account's preferences. */
export function accountSyncPrefs(registryId: string): AccountSyncPrefs {
  const a = useDeviceSyncStore.getState().accounts[registryId] ?? emptyAccountDeviceSync();
  return {
    contactsSelection: a.contactsSelection,
    calendarSelection: a.calendarSelection,
    newContactsAddressBook: a.newContactsAddressBook,
    reminderOwner: a.reminderOwner ?? 'device',
  };
}
