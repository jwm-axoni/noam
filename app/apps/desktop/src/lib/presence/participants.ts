// The participant registry as the desktop sees it (`GET /api/orgs/:orgId/participants`).
// A participant is a human member or (from Phase 3) an agent; its display name
// and color are server-assigned, so every client renders the same identity.

export interface Participant {
  id: string;
  kind: "human" | "agent";
  displayName: string;
  /** Registry color, one of `PRESENCE_PALETTE`. */
  color: string;
  harness: string | null;
  createdAt: string;
}

export interface ResolvedIdentity {
  name: string;
  color: string;
}

/**
 * Registry-signed display: when a participant id is known locally, the
 * registry's name/color win over whatever a peer asserted about itself;
 * unknown ids fall back to the asserted values.
 */
export class ParticipantDirectory {
  private readonly byId = new Map<string, Participant>();

  constructor(participants: readonly Participant[]) {
    for (const p of participants) this.byId.set(p.id, p);
  }

  get(participantId: string | null | undefined): Participant | undefined {
    return participantId ? this.byId.get(participantId) : undefined;
  }

  resolve(participantId: string | null | undefined, fallback: ResolvedIdentity): ResolvedIdentity {
    const p = this.get(participantId);
    return p ? { name: p.displayName, color: p.color } : fallback;
  }
}

// One directory per participants array (the store replaces the array on every
// refresh), so resolving on every caret redraw never rebuilds the map.
const directories = new WeakMap<readonly Participant[], ParticipantDirectory>();

export function directoryFor(participants: readonly Participant[]): ParticipantDirectory {
  let dir = directories.get(participants);
  if (!dir) {
    dir = new ParticipantDirectory(participants);
    directories.set(participants, dir);
  }
  return dir;
}
