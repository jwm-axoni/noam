// In-memory sample suggestions mirroring the diff-loop mocks. This is the only
// "source" until ADR-1 defines the CRDT staging primitive; it is gated behind
// `flag.ts` and never touches the note, the bridge or sync.

import type { ReviewAuthor, Suggestion } from "./model";

// Okabe-Ito agent palette (plan §05), assigned in registry order.
export const DEMO_CLAUDE: ReviewAuthor = { participantId: "demo-agent-claude", displayName: "Claude", color: "#009E73", kind: "agent" };
export const DEMO_CODEX: ReviewAuthor = { participantId: "demo-agent-codex", displayName: "Codex", color: "#0072B2", kind: "agent" };

export const DEMO_DIGEST =
  "Claude drafted the launch checklist and proposed a new intro. Two suggestions are waiting, and one needs your call because you edited the title after Codex proposed a change. Nothing was applied without you.";

export function demoSuggestions(docId = "demo-note", now = Date.now()): Suggestion[] {
  return [
    {
      id: "demo-intro",
      docId,
      author: DEMO_CLAUDE,
      kind: "replace",
      from: 0,
      to: 30,
      before: "Noam is a notes app with sync.",
      after: "Launch is six weeks out. The build is stable, the site is live, and the only thing left is telling the story right.",
      createdAt: now - 2 * 60_000,
      title: "Stronger intro",
      state: "pending",
    },
    {
      id: "demo-checklist",
      docId,
      author: DEMO_CLAUDE,
      kind: "insert",
      from: 80,
      to: 80,
      before: "",
      after: "Publish the migration guide",
      createdAt: now - 60_000,
      title: "New checklist item",
      state: "pending",
    },
    {
      id: "demo-title",
      docId,
      author: DEMO_CODEX,
      kind: "replace",
      from: 0,
      to: 11,
      before: "Q3 Planning",
      after: "Q3 Launch Plan",
      createdAt: now - 4 * 60_000,
      title: "Title change",
      state: "conflict",
      mine: "Q3 Planning (draft)",
      target: "title",
    },
  ];
}
