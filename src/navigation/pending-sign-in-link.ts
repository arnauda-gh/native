import { create } from 'zustand';
import type { QrLoginPayload } from '../lib/oauth';

// A tapped `bulwarkmail://` sign-in link arrives before the login screen is
// up (cold start, or signed in with Add account not open yet). It is parked
// here and taken by LoginScreen, which runs it like a scanned code. Taking
// clears it, so one link signs in once however often it is delivered.
interface PendingSignInLinkState {
  payload: QrLoginPayload | null;
  set: (payload: QrLoginPayload | null) => void;
  take: () => QrLoginPayload | null;
}

export const usePendingSignInLinkStore = create<PendingSignInLinkState>((set, get) => ({
  payload: null,
  set: (payload) => set({ payload }),
  take: () => {
    const payload = get().payload;
    if (payload) set({ payload: null });
    return payload;
  },
}));

export function setPendingSignInLink(payload: QrLoginPayload | null): void {
  usePendingSignInLinkStore.getState().set(payload);
}
