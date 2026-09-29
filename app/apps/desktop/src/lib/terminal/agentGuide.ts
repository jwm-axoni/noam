// The AGENTS.md offer (terminal T3).
//
// A coding agent in the embedded terminal can read and write anything the user
// can, including `.context/` — the index, every note's CRDT history and the
// doc-id map. The existing guards (bulk-delete cap, trash copies, the 0-byte
// ingest refusal) catch the worst of it; this adds the cheap first line of
// defence: a vault-root AGENTS.md that tells agents the rules.
//
// It is OFFERED, never written silently: it is a visible `.md` file, so in a
// synced vault it becomes a note every teammate sees. The write is create-only
// (`write_note_if_missing`), so an AGENTS.md or CLAUDE.md the user already has
// is never touched, and the watcher registers the new files exactly like any
// other external writer's.

import * as ipc from "../ipc";

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";

export const AGENTS_MD = `# Working in this Noam vault

This folder is a Noam vault. Every \`.md\` file in it is a note, and Noam syncs
changes to your teammates as they happen. Edit files in place like any other
text file; Noam merges your edits with whatever people are typing at the same
moment.

## Never touch \`.context/\`

\`.context/\` holds Noam's search index, the edit history of every note and the
link between this folder and the sync server. Don't read, write, move or delete
anything in it, and don't add it to git. Damaging it can cost people their
notes.

## Editing notes

- Change only the part of a note you mean to change. Rewriting a whole file to
  fix one line works, but it makes the change hard for people to review.
- Keep the frontmatter block (between the \`---\` lines at the top) valid YAML.
- Link notes with \`[[Note name]]\`. Tags look like \`#tag\`.
- To rename or move a note, move the file. Noam keeps its history.
- Deleting a note deletes it for everyone who can see it. Ask before deleting,
  and never delete many files at once.

## Other files

- Images and other attachments live in \`attachments/\`.
- Files and folders whose names start with \`.\` are ignored by Noam.
`;

/** Claude Code reads CLAUDE.md, and `@path` imports another file into it. */
export const CLAUDE_MD = `# Claude Code

Read @AGENTS.md before working in this vault.
`;

export interface GuideState {
  agentsExists: boolean;
  claudeExists: boolean;
  rootFrozen: boolean;
  dismissed: boolean;
}

export interface GuidePlan {
  offer: boolean;
  /** Files the offer would create, in order. Never one that exists. */
  files: string[];
  /** The user's own CLAUDE.md stays as it is and needs the import added by hand. */
  claudeLeftAlone: boolean;
}

/** Whether to offer, and what accepting would create. Pure. */
export function planAgentGuide(state: GuideState): GuidePlan {
  if (state.agentsExists || state.rootFrozen || state.dismissed) {
    return { offer: false, files: [], claudeLeftAlone: false };
  }
  return {
    offer: true,
    files: state.claudeExists ? [AGENTS_FILE] : [AGENTS_FILE, CLAUDE_FILE],
    claudeLeftAlone: state.claudeExists,
  };
}

const CONTENT: Record<string, string> = {
  [AGENTS_FILE]: AGENTS_MD,
  [CLAUDE_FILE]: CLAUDE_MD,
};

// ---- "Don't ask again", per vault, on this device --------------------------

const DISMISS_PREFIX = "noam.terminal.agentGuide.dismissed:";

export function isGuideDismissed(vaultPath: string): boolean {
  try {
    return localStorage.getItem(DISMISS_PREFIX + encodeURIComponent(vaultPath)) === "1";
  } catch {
    return false;
  }
}

export function dismissGuideForever(vaultPath: string): void {
  try {
    localStorage.setItem(DISMISS_PREFIX + encodeURIComponent(vaultPath), "1");
  } catch {
    // Storage refused: "Not now" semantics for this session, which is harmless.
  }
}

// ---- Session state shared by every terminal panel --------------------------
// One answer per vault per app session: act on the offer in one terminal and
// it leaves every other terminal too.

const answered = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function subscribeGuide(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function guideVersion(): number {
  return version;
}

export function isGuideAnswered(vaultPath: string): boolean {
  return answered.has(vaultPath);
}

export function answerGuide(vaultPath: string): void {
  answered.add(vaultPath);
  version += 1;
  for (const listener of listeners) listener();
}

/** Test seam. */
export function resetGuideSession(): void {
  answered.clear();
  version += 1;
}

/** Read what the plan needs from disk. */
export async function readGuideState(
  vaultPath: string,
  rootFrozen: boolean,
  epoch: ipc.VaultEpoch,
): Promise<GuideState> {
  const [agentsExists, claudeExists] = await Promise.all([
    ipc.noteExists(AGENTS_FILE, epoch),
    ipc.noteExists(CLAUDE_FILE, epoch),
  ]);
  return {
    agentsExists,
    claudeExists,
    rootFrozen,
    dismissed: isGuideDismissed(vaultPath) || isGuideAnswered(vaultPath),
  };
}

/** Create the planned files, create-only. Returns the ones actually written. */
export async function writeAgentGuide(
  files: string[],
  epoch: ipc.VaultEpoch,
  write: (path: string, content: string, epoch: ipc.VaultEpoch) => Promise<boolean> =
    ipc.writeNoteIfMissing,
): Promise<string[]> {
  const created: string[] = [];
  for (const file of files) {
    const content = CONTENT[file];
    if (content == null) continue;
    if (await write(file, content, epoch)) created.push(file);
  }
  return created;
}
