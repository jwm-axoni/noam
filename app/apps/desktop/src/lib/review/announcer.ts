// A polite live region must not chatter: at most one announcement per
// interval. The first message speaks immediately; anything arriving inside
// the window is coalesced and only the LATEST is spoken when it closes, so a
// burst of `]` presses ends on where the reviewer actually landed.

export interface Announcer {
  announce(text: string): void;
  dispose(): void;
}

export const ANNOUNCE_INTERVAL_MS = 5000;

export function createAnnouncer(
  emit: (text: string) => void,
  intervalMs = ANNOUNCE_INTERVAL_MS,
  now: () => number = () => Date.now(),
): Announcer {
  let last = -Infinity;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    last = now();
    emit(text);
  };

  return {
    announce(text) {
      if (!text) return;
      const wait = last + intervalMs - now();
      if (wait <= 0 && timer === null) {
        last = now();
        emit(text);
        return;
      }
      pending = text;
      if (timer === null) timer = setTimeout(flush, Math.max(0, wait));
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
