// Screen-reader announcements for presence changes ("Maya joined", "Maya
// disconnected", "2 people in this note"). Coalesced to at most one per
// ANNOUNCE_INTERVAL_MS so a busy vault never floods the live region; within a
// window the latest message wins. The single `<PresenceLiveRegion />` renders
// whatever this module last emitted.

export const ANNOUNCE_INTERVAL_MS = 5_000;

export class AnnouncementDebouncer {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly emit: (message: string) => void,
    private readonly intervalMs = ANNOUNCE_INTERVAL_MS,
  ) {}

  push(message: string): void {
    this.pending = message;
    if (this.timer) return;
    const wait = this.lastAt + this.intervalMs - Date.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private flush(): void {
    this.timer = null;
    if (this.pending === null) return;
    const message = this.pending;
    this.pending = null;
    this.lastAt = Date.now();
    this.emit(message);
  }
}

// ---- the app-wide feed the live region subscribes to ----

let current = "";
const listeners = new Set<() => void>();
const debouncer = new AnnouncementDebouncer((message) => {
  current = message;
  for (const l of listeners) l();
});

/** Queue a polite presence announcement. */
export function queueAnnouncement(message: string): void {
  debouncer.push(message);
}

export function subscribePresenceAnnouncement(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPresenceAnnouncement(): string {
  return current;
}
