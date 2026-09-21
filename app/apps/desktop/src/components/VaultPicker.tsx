import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import type { VaultInfo, RecentVault } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { LEFT_DOCK_MIN } from "../layout/geometry";
import { DEFAULT_LEFT_WIDTH } from "../layout/types";
import { openExistingVault } from "../lib/vault/openExisting";
import {
  readKnownVaults,
  readLastVault,
  readOrgVaults,
  requestJoinWithCode,
  requestOpenVault,
  useStore,
} from "../store";
import { Wordmark } from "./Logo";
import { LazyAvatar } from "./Face";
import { MenuIcon } from "./MenuIcon";
import { Spinner } from "./Spinner";
import { ThemeToggle } from "./ThemeToggle";

/* Its own handle on the same chunk every other sign-in mount uses — the
   welcome screen must not drag the auth modal in just by rendering. */
const AuthDialog = lazy(() => import("./AuthDialog").then((m) => ({ default: m.AuthDialog })));

/**
 * A row in the welcome-screen list: either a local folder (a recent vault on
 * disk) or a synced *remote* vault (an org). Remote rows carry the org id so a
 * click can reopen + resync them — prompting sign-in first if signed out.
 *
 * A local row additionally knows whether its folder IS some vault's synced
 * folder (`syncedOrgId`, read from the folder's own `.context/config.json`).
 * The localStorage caches that used to be the only classification signal are
 * per-device and easy to lose — which left a synced folder listed as if it
 * were plain local, openable (and editable) with no hint that it syncs.
 */
type PickerEntry =
  | {
      kind: "local";
      key: string;
      name: string;
      path: string;
      openedAt: number;
      syncedOrgId: string | null;
    }
  | { kind: "remote"; key: string; name: string; path: string | null; orgId: string };

/** Is this row a synced vault (as opposed to a local-only folder)? */
function isSyncedEntry(e: PickerEntry): boolean {
  return e.kind === "remote" || e.syncedOrgId !== null;
}

// Springs tuned for small UI: snappy but soft-landing (no rubber-banding).
const SPRING = { type: "spring", stiffness: 300, damping: 24 } as const;

function PlusGlyph() {
  return (
    <MenuIcon>
      <path d="M12 5v14M5 12h14" />
    </MenuIcon>
  );
}

function FolderGlyph() {
  return (
    <MenuIcon>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </MenuIcon>
  );
}

function PeopleGlyph() {
  return (
    <MenuIcon>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M17.5 13.5a6.5 6.5 0 0 1 4 6.5" />
    </MenuIcon>
  );
}

function CloudGlyph() {
  return (
    <MenuIcon>
      <path d="M17.5 19a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.3 9.2 4.5 4.5 0 0 0 7 18.99h10.5Z" />
    </MenuIcon>
  );
}

function PersonGlyph() {
  return (
    <MenuIcon>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </MenuIcon>
  );
}

export function welcomeGreeting(hour = new Date().getHours()): string {
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

/** Compact "time since" label for a recent vault, e.g. "just now", "3h ago". */
function relativeTime(ms: number): string {
  if (!ms) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Collapse a home-prefixed path for display: /Users/x/Notes → ~/Notes. */
function tidyPath(path: string): string {
  const m = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)(.*)$/);
  return m ? "~" + m[2] : path;
}

export function VaultPicker() {
  const authStatus = useStore((s) => s.authStatus);
  const session = useStore((s) => s.session);
  // A link-driven prompt (shared note / server invite / team invitation) mounts
  // its OWN AuthDialog from App.tsx, over this same welcome screen. Two stacked
  // sign-in modals is not a hypothetical: an invitation link clicked while the
  // picker's own dialog is open would put one card on top of the other, each
  // with its own idea of what happens after sign-in. The prompted one wins —
  // it is the one that arrived with a reason attached.
  const authPrompt = useStore((s) => s.authPrompt);
  // The live vault list. Signed in, this is the truth and the cache below is
  // only its mirror; signed out it is empty and the cache is all we have.
  const organizations = useStore((s) => s.organizations);
  const serverUrl = useStore((s) => s.serverUrl);
  // Sign-in succeeded and a vault is being resolved/created. There's no vault
  // yet, so App still renders this screen — and without saying so, a sign-in
  // that is working looks identical to one that silently did nothing.
  const landingVault = useStore((s) => s.landingVault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentVault[]>([]);
  // When a signed-out user clicks a remote vault we open the sign-in modal;
  // the vault to land in afterwards is stashed via requestOpenVault().
  const [signInOpen, setSignInOpen] = useState(false);
  // Why the sign-in modal is up. "open" is the remote-vault-card route (land in
  // that vault); "join" is the join-code route, which comes back HERE for the
  // code instead of landing anywhere.
  const [signInFor, setSignInFor] = useState<"open" | "join">("open");
  // Join-with-code step: true = the code form is showing (we already have a
  // session). null/false = idle.
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  // New-vault flow: null = idle; a string = chosen parent, awaiting a name.
  const [newParent, setNewParent] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // Which recent-vault card is being opened, by its key. A single boolean would
  // only tell the list to grey out; the point is to mark the row you clicked.
  const [opening, setOpening] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  // Surface recently opened vaults as one-tap "reopen" affordances.
  //
  // Re-read whenever the vault set changes, NOT just on mount. Deleting your
  // last vaults leaves this screen mounted the whole time (App renders it as
  // soon as `vault` goes null), so a mount-only load left the deleted vaults
  // listed until the app was reloaded — the deletion looked like it hadn't
  // worked. `organizations` and `authStatus` are the store's account-level
  // signals; both change on delete, sign-out and server switch.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await ipc.getRecentVaults();
        if (alive) setRecents(list);
      } catch {
        /* no recents — ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [organizations, authStatus]);

  // { path → the vault (org) that folder's own `.context/config.json` is
  // stamped for }. The on-disk truth behind the row tags: the localStorage
  // caches (org list, org→folder bindings) are per-device and easy to lose,
  // and every cache miss used to demote a synced folder to a plain "recent" —
  // openable signed-out with no hint that its edits sync somewhere.
  const [stamps, setStamps] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const peeked = await Promise.all(
        recents.map(async (r) => {
          const stamp = await ipc.peekVaultStamp(r.path).catch(() => null);
          return [r.path, stamp?.organizationId ?? null] as const;
        }),
      );
      if (!alive) return;
      const next: Record<string, string> = {};
      for (const [path, orgId] of peeked) if (orgId) next[path] = orgId;
      setStamps(next);
    })();
    return () => {
      alive = false;
    };
  }, [recents]);

  // If this screen goes away mid-join (a vault opened by some other route),
  // the landing suppression must not outlive it. A *successful* join disarms
  // it in the store before switching in, so this only catches abandonment.
  useEffect(() => () => requestJoinWithCode(false), []);

  async function openVault(vault: VaultInfo | null, opts?: { seed?: boolean }) {
    if (!vault) return;
    // Rust already opened it (these are the picker/create commands), so the store
    // retires the previous vault's sync and reloads view state from the new one.
    await useStore.getState().adoptOpenedVault(vault, opts);
  }

  // "Open by path": a typed/pasted absolute path, for what the native picker
  // cannot select — notably a drive root (a bare `D:\` or a mounted volume).
  // The OS folder dialog only offers folders *inside* a drive, so the only way
  // to make the drive itself the vault is to say so in text (#75).
  const [pathOpen, setPathOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");
  // Its own error, not the card's shared one: the form is a modal, and an
  // error rendered on the card underneath would sit behind the backdrop.
  const [pathError, setPathError] = useState<string | null>(null);
  function closePathOpen() {
    setPathOpen(false);
    setPathError(null);
  }
  async function openByPath() {
    const path = manualPath.trim();
    if (!path) return;
    setBusy(true);
    setPathError(null);
    try {
      // `openLocalVault`, not `adoptOpenedVault`: WE control this open, so the
      // store can tear down any active vault sync before Rust swaps the slot.
      await useStore.getState().openLocalVault(path);
    } catch (e) {
      setPathError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // "Open existing": native folder picker → open the chosen vault.
  async function pickExisting() {
    setBusy(true);
    setError(null);
    try {
      await openExistingVault();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // "New vault": ask for a name, nothing else.
  //
  // It used to open a folder picker first, which was a question with one
  // sensible answer — every vault we create lives under the vaults root
  // anyway, so choosing its parent was ceremony. Adopting a folder you already
  // have is what "Open existing" is for, and that one keeps the folder exactly
  // where you picked it.
  async function startNewVault() {
    setError(null);
    try {
      setNewParent(await ipc.getVaultsRoot());
      setNewName("");
    } catch (e) {
      setError(String(e));
    }
  }

  // "New vault" step 2: create <vaults root>/<name> and open it.
  async function confirmNewVault() {
    if (!newParent || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const vault = await ipc.createVault(newParent, newName.trim());
      // Creating a vault is the one flow that seeds starter content; "Open
      // existing" above adopts the picked folder untouched.
      await openVault(vault, { seed: true });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function cancelNewVault() {
    setNewParent(null);
    setNewName("");
    setError(null);
  }

  // "Join a team": redeem a code a teammate shared, without first inventing a
  // vault of your own.
  //
  // The code alone can't do anything — joining is a server action, so it needs
  // an account. Signed out, we therefore run sign-up/sign-in first and come back
  // here for the code. `requestJoinWithCode` is what keeps that round trip from
  // ending somewhere else: it suppresses the post-auth landing, which would
  // otherwise hand a brand-new account an auto-created "My Vault" and drop the
  // user into it. That was the whole detour this replaces — create a vault you
  // didn't want, then hunt for the code box in Vault settings.
  function startJoin() {
    setError(null);
    setJoinError(null);
    setJoinCode("");
    requestJoinWithCode(true);
    if (authStatus === "signed-in") {
      setJoining(true);
    } else {
      setSignInFor("join");
      setSignInOpen(true);
    }
  }

  function cancelJoin() {
    requestJoinWithCode(false);
    setJoining(false);
    setJoinCode("");
    setJoinError(null);
    // Backing out AFTER the sign-up this route required would otherwise leave a
    // signed-in account holding nothing at all — the one state this screen has
    // no good answer for, since its three buttons all assume you still have a
    // choice to make. So run the landing the sign-in skipped, which makes the
    // first vault. Only for an empty account: someone who already has vaults
    // sees them listed right here, and yanking them into one they didn't click
    // would be its own surprise.
    const s = useStore.getState();
    if (s.authStatus === "signed-in" && s.organizations.length === 0) {
      void s.landAfterAuth();
    }
  }

  async function confirmJoin() {
    const code = joinCode.trim();
    if (!code) return;
    setBusy(true);
    setJoinError(null);
    try {
      // On success the store switches into the joined vault, which binds it a
      // folder and unmounts this screen — so there's nothing to do here after.
      await useStore.getState().joinVault(code);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reopenLocal(path: string) {
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().openLocalVault(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Open a vault row. Local-only folders open in place. A synced vault —
  // whether a cached remote row or a local folder whose own config says it
  // syncs — needs a session: if we still have one, switch straight to it
  // (opening its folder + resyncing); if we're signed out — or signed in as an
  // account that can't see it — remember it and prompt sign-in;
  // landInLastVault opens it once the right session lands. Opening
  // a synced folder *without* a session would edit it silently offline under a
  // "local" label; the escape hatch for deliberate offline work is "Open
  // existing", not a click that looks like any other.
  async function openEntry(e: PickerEntry) {
    setOpening(e.key);
    try {
      if (e.kind === "local" && !e.syncedOrgId) {
        await reopenLocal(e.path);
        return;
      }
      const orgId = e.kind === "remote" ? e.orgId : (e.syncedOrgId as string);
      if (authStatus === "signed-in") {
        setBusy(true);
        setError(null);
        try {
          if (!organizations.some((o) => o.id === orgId)) {
            // A stamped folder whose vault this account can't see. Switching
            // would 403, and adopting it would duplicate another account's
            // vault. Hand over to the right account instead of dead-ending:
            // drop this session and offer sign-in with the vault stashed, so
            // the post-auth landing opens exactly it. (The dialog needs the
            // sign-out — it dismisses itself while a session exists.)
            setError(
              `"${e.name}" was synced under a different account. Sign in with that account to open it.`,
            );
            await useStore.getState().signOut();
            requestOpenVault(orgId);
            setSignInFor("open");
            setSignInOpen(true);
            return;
          }
          await useStore.getState().setActiveOrganization(orgId);
        } catch (err) {
          setError(String(err));
        } finally {
          setBusy(false);
        }
      } else {
        requestOpenVault(orgId);
        setSignInFor("open");
        setSignInOpen(true);
      }
    } finally {
      setOpening(null);
    }
  }

  async function forget(path: string) {
    setRecents((rs) => rs.filter((r) => r.path !== path));
    try {
      await ipc.removeRecentVault(path);
    } catch {
      /* best-effort; UI already updated */
    }
  }

  const naming = newParent !== null;
  // A step that owns the screen is showing (naming a new vault, entering a join
  // code, or the post-sign-in landing) — hide the recents/hint/sign-in behind
  // it. Offering "New vault" while we are already making one is how you end up
  // with two.
  const inFlow = naming || joining || landingVault;

  // Merge synced (remote) vaults with local recents into one list. Remote
  // vaults come from the locally-cached org list (survives sign-out) and are
  // shown first; their bound folder — if any — comes from the org→folder map,
  // healed by the folders' own config stamps when the map is missing. Local
  // recents backing a synced vault are folded into the remote row (by path)
  // so nothing shows twice; the ones left over carry their own stamp so a
  // synced folder is *tagged* as synced even when its vault isn't in the
  // cached list at all (other account, cleared cache, other server).
  const entries = useMemo<PickerEntry[]>(() => {
    // Signed in, the store's list is authoritative — reading the cache here
    // would resurrect a vault deleted moments ago, because the cache is only
    // rewritten by the next `refreshVault`. Signed out, the cache is the point:
    // it is what lets this screen still offer your synced vaults.
    const known =
      authStatus === "signed-in"
        ? organizations.map((o) => ({ id: o.id, name: o.name }))
        : readKnownVaults(serverUrl);
    const orgVaults = readOrgVaults();
    // Fallback folder per org from the folders' own stamps — recents are
    // newest-first, so the first stamped match wins (the one most recently
    // opened, i.e. the copy the user actually uses).
    const stampedPathByOrg: Record<string, string> = {};
    for (const r of recents) {
      const org = stamps[r.path];
      if (org && !(org in stampedPathByOrg)) stampedPathByOrg[org] = r.path;
    }
    const remote: PickerEntry[] = known.map((w) => ({
      kind: "remote",
      key: `org:${w.id}`,
      name: w.name,
      path: orgVaults[w.id] ?? stampedPathByOrg[w.id] ?? null,
      orgId: w.id,
    }));
    const consumed = new Set(remote.map((r) => r.path).filter(Boolean));
    const local: PickerEntry[] = recents
      .filter((r) => !consumed.has(r.path))
      .map((r) => ({
        kind: "local",
        key: r.path,
        name: r.name,
        path: r.path,
        openedAt: r.openedAt,
        syncedOrgId: stamps[r.path] ?? null,
      }));
    return [...remote, ...local];
  }, [recents, stamps, organizations, authStatus, serverUrl]);

  // One vault row in the welcome shell's scrolling vault column.
  // Every row carries a truthful state tag (docs' vault states): "Remote" =
  // synced, no local folder here yet; "Synced" = synced with a folder on this
  // device; "Local" = a plain folder that syncs nowhere. The tag comes from
  // the folder's own config (via `stamps`), not just the localStorage caches,
  // so signing out can't demote a synced vault to an untagged "recent".
  const renderEntry = (e: PickerEntry) => {
    const synced = isSyncedEntry(e);
    const tag = e.kind === "remote" && !e.path ? "Remote" : synced ? "Synced" : "Local";
    return (
      <div className={`welcome-vault-row${opening === e.key ? " is-opening" : ""}`} key={e.key}>
        <button
          className="welcome-vault-open"
          disabled={busy}
          aria-busy={opening === e.key || undefined}
          onClick={() => void openEntry(e)}
          title={e.path ?? e.name}
        >
          <span className="welcome-vault-icon" aria-hidden="true">
            {synced ? <CloudGlyph /> : <FolderGlyph />}
          </span>
          <span className="welcome-vault-name" title={e.name}>
            {e.name}
          </span>
          {/* The card the user clicked reports for itself. A single shared `busy`
              flag only greyed every row out, which says "the list is disabled"
              rather than "this one is opening" — and opening a vault is seconds
              of work. */}
          {opening === e.key ? (
            <Spinner size="xs" tone="accent" className="welcome-vault-badge" />
          ) : (
            <span className="welcome-vault-badge">
              <span className={`ws-badge ${synced ? "synced" : "local"}`}>{tag}</span>
            </span>
          )}
          <span className="welcome-vault-path">
            {opening === e.key
              ? "Opening…"
              : e.path
                ? synced && authStatus !== "signed-in"
                  ? `${tidyPath(e.path)} · sign in to open`
                  : tidyPath(e.path)
                : "Synced · sign in to open"}
          </span>
        </button>
        {e.kind === "local" && (
          <button
            className="welcome-vault-remove"
            aria-label={`Remove ${e.name} from recents`}
            title="Remove from recents"
            disabled={busy}
            onClick={() => forget(e.path)}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  // The list groups remote vaults before local ones, so its first row is not
  // necessarily the vault used most recently. Follow the newest local recent
  // path first. A synced vault resolves through its bound path and still wins
  // when it really was the last one opened. If this device has no usable path
  // history, fall back to the remembered or session-active synced vault.
  const newestRecentPath = recents[0]?.path ?? null;
  const rememberedOrgId = readLastVault();
  const activeOrgId = session?.activeOrganizationId ?? null;
  const continueEntry =
    (newestRecentPath
      ? (entries.find((entry) => entry.path === newestRecentPath) ?? null)
      : null) ??
    (rememberedOrgId
      ? (entries.find(
          (entry) => entry.kind === "remote" && entry.orgId === rememberedOrgId,
        ) ?? null)
      : null) ??
    (activeOrgId
      ? (entries.find((entry) => entry.kind === "remote" && entry.orgId === activeOrgId) ??
        null)
      : null);
  const continueSynced = continueEntry ? isSyncedEntry(continueEntry) : false;
  const continueTag =
    continueEntry?.kind === "remote" && !continueEntry.path
      ? "Remote"
      : continueSynced
        ? "Synced"
        : "Local";
  const userLabel = session?.user.name || session?.user.email || "Not signed in";
  const shellStyle = {
    "--welcome-sidebar-width": `${DEFAULT_LEFT_WIDTH}px`,
    "--welcome-sidebar-min-width": `${LEFT_DOCK_MIN}px`,
  } as CSSProperties;

  return (
    <div className="vault-picker" style={shellStyle}>
      <div className="titlebar-drag" data-tauri-drag-region />

      <aside className="welcome-sidebar" aria-label="Your vaults">
        <div className="welcome-brand">
          <Wordmark />
        </div>
        <p className="welcome-eyebrow">Your vaults</p>
        <div className="welcome-vault-list">
          {entries.length > 0 ? (
            entries.map(renderEntry)
          ) : (
            <div className="welcome-vault-empty">
              <strong>No vaults yet</strong>
              Create one on the right, or open a folder of <code>.md</code> files you already
              have.
            </div>
          )}
        </div>
        <div className="welcome-identity">
          {session ? (
            <LazyAvatar label={userLabel} image={session.user.image} />
          ) : (
            <span className="welcome-signed-out-avatar" aria-hidden="true">
              <PersonGlyph />
            </span>
          )}
          <span className="welcome-identity-copy">
            <span className="welcome-identity-name">
              {authStatus === "unknown" ? "Checking account…" : userLabel}
            </span>
            {session && <span className="welcome-identity-hint">Ready to sync</span>}
          </span>
          {!session && (
            <button
              type="button"
              className="primary sm welcome-signin"
              disabled={busy || authStatus === "unknown" || inFlow}
              aria-expanded={signInOpen}
              onClick={() => {
                setSignInFor("open");
                setSignInOpen(true);
              }}
            >
              Sign in
            </button>
          )}
          <ThemeToggle />
        </div>
      </aside>

      <main
        className={`welcome-document${entries.length === 0 || landingVault ? " is-centered" : ""}`}
      >
        <div className="welcome-page">
          <div className="welcome-heading">
            <h1>{entries.length > 0 ? welcomeGreeting() : "Welcome to Noam."}</h1>
            <p>
              {entries.length > 0
                ? "Pick up where you left off, or start somewhere new."
                : "A vault is any folder of Markdown files on this Mac. Create one, open a folder you already have, or join a team with a code."}
            </p>
          </div>

          {error && <p className="error">{error}</p>}

          {!inFlow && continueEntry && (
            <div className="welcome-continue">
              <span className="welcome-action-icon" aria-hidden="true">
                {continueSynced ? <CloudGlyph /> : <FolderGlyph />}
              </span>
              <span className="welcome-continue-copy">
                <span className="welcome-eyebrow">Continue where you left off</span>
                <span className="welcome-continue-name">
                  <span className="welcome-continue-name-text" title={continueEntry.name}>
                    {continueEntry.name}
                  </span>
                  <span className={`ws-badge ${continueSynced ? "synced" : "local"}`}>
                    {continueTag}
                  </span>
                </span>
                <span className="welcome-continue-path">
                  {continueEntry.path ? tidyPath(continueEntry.path) : "Synced · sign in to open"}
                  {continueEntry.kind === "local" && continueEntry.openedAt > 0
                    ? ` · ${relativeTime(continueEntry.openedAt)}`
                    : ""}
                </span>
              </span>
              <button
                type="button"
                className={`primary${opening === continueEntry.key ? " is-busy" : ""}`}
                disabled={busy}
                aria-busy={opening === continueEntry.key || undefined}
                onClick={() => void openEntry(continueEntry)}
              >
                <span className="async-btn-label">
                  {opening === continueEntry.key ? "Opening…" : "Open"}
                </span>
                {opening === continueEntry.key && <Spinner size="xs" tone="on-accent" />}
              </button>
            </div>
          )}

          <div className="welcome-flow">
            <AnimatePresence mode="wait" initial={false}>
              {landingVault ? (
              // ---- Signed in, opening (or creating) their vault. This screen
              //      is still up only because there is no vault yet; say so,
              //      or a working sign-in is indistinguishable from one that
              //      dropped the user straight back here. ----
              <motion.div
                key="landing"
                className="picker-landing"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={SPRING}
              >
                <Spinner size="sm" tone="accent" />
                <p className="picker-landing-label" role="status">
                  Opening your vault…
                </p>
              </motion.div>
            ) : joining ? (
              // ---- Join step: the account exists (we forced sign-in first if
              //      it didn't), so all that's left is the code. Redeeming it
              //      switches straight into the team's vault — no vault of your
              //      own required, which is the entire point of this route. ----
              <motion.form
                key="joining"
                className="new-vault-form"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={SPRING}
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirmJoin();
                }}
              >
                <label className="new-vault-label">Enter your team's join code</label>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input
                  className="new-vault-input join-code-input"
                  autoFocus
                  value={joinCode}
                  disabled={busy}
                  // Codes are generated uppercase; typing them lowercase is not
                  // a mistake worth an error message.
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelJoin();
                  }}
                  placeholder="K7MPX2RA"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="new-vault-loc">
                  Ask a teammate for it — Vault settings → Members.
                </p>
                {joinError && <p className="error join-error">{joinError}</p>}
                <div className="new-vault-buttons">
                  <button
                    type="button"
                    className="ghost-pill"
                    disabled={busy}
                    onClick={cancelJoin}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`primary sm${busy ? " is-busy" : ""}`}
                    disabled={busy || !joinCode.trim()}
                    aria-busy={busy || undefined}
                  >
                    {/* Joining is a round trip plus a full vault switch — folder,
                        registry reconcile, first pull. Seconds, not a blink. */}
                    <span className="async-btn-label">
                      {busy ? "Joining…" : "Join team"}
                    </span>
                    {busy && <Spinner size="xs" tone="on-accent" />}
                  </button>
                </div>
              </motion.form>
            ) : naming ? (
              // ---- Naming step: only reached via "Create inside" an existing
              //      vault, where a nested vault does need its own folder name.
              //      The normal "New vault" flow skips this — the picked folder
              //      is the vault. ----
              <motion.form
                key="naming"
                className="new-vault-form"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={SPRING}
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirmNewVault();
                }}
              >
                <label className="new-vault-label">Name your vault</label>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input
                  className="new-vault-input"
                  autoFocus
                  value={newName}
                  disabled={busy}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelNewVault();
                  }}
                  placeholder="Untitled Vault"
                  spellCheck={false}
                />
                <p className="new-vault-loc" title={newParent ?? undefined}>
                  in <code>{tidyPath(newParent ?? "")}</code>
                </p>
                <div className="new-vault-buttons">
                  <button
                    type="button"
                    className="ghost-pill"
                    disabled={busy}
                    onClick={cancelNewVault}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`primary sm${busy ? " is-busy" : ""}`}
                    disabled={busy || !newName.trim()}
                    aria-busy={busy || undefined}
                  >
                    {/* Creating a vault writes the folder, opens it, and seeds
                        ~20 starter notes — comfortably past the point where a
                        static label reads as a stuck button. */}
                    <span className="async-btn-label">
                      {busy ? "Creating…" : "Create vault"}
                    </span>
                    {busy && <Spinner size="xs" tone="on-accent" />}
                  </button>
                </div>
              </motion.form>
            ) : (
              <motion.div
                key="actions"
                className="welcome-action-cards"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduceMotion ? undefined : { opacity: 0 }}
                transition={SPRING}
              >
                <div className="welcome-action-card">
                  <span className="welcome-action-icon is-primary" aria-hidden="true">
                    <PlusGlyph />
                  </span>
                  <span className="welcome-action-copy">
                    <span className="welcome-action-title">New vault</span>
                    <span className="welcome-action-hint">
                      A fresh folder seeded with a few starter notes.
                    </span>
                  </span>
                  <button className="primary" disabled={busy} onClick={startNewVault}>
                    Create
                  </button>
                </div>
                <div className="welcome-action-card">
                  <span className="welcome-action-icon" aria-hidden="true">
                    <FolderGlyph />
                  </span>
                  <span className="welcome-action-copy">
                    <span className="welcome-action-title">Open existing</span>
                    <span className="welcome-action-hint">
                      Any folder of Markdown files on this device. It stays where it is.
                    </span>
                  </span>
                  <button
                    className={`ghost-pill${busy ? " is-busy" : ""}`}
                    disabled={busy}
                    aria-busy={busy || undefined}
                    onClick={pickExisting}
                  >
                    <span className="async-btn-label">
                      {busy ? "Opening…" : "Choose folder"}
                    </span>
                    {busy && <Spinner size="xs" tone="neutral" />}
                  </button>
                </div>
                <div className="welcome-action-card">
                  <span className="welcome-action-icon" aria-hidden="true">
                    <PeopleGlyph />
                  </span>
                  <span className="welcome-action-copy">
                    <span className="welcome-action-title">Join a team</span>
                    <span className="welcome-action-hint">
                      Redeem a join code from a teammate and land in their vault.
                    </span>
                  </span>
                  <button className="ghost-pill" disabled={busy} onClick={startJoin}>
                    Enter code
                  </button>
                </div>
              </motion.div>
              )}
            </AnimatePresence>
          </div>

          {!inFlow && (
            <p className="hint welcome-hint">
              A vault is any folder of <code>.md</code> files.{" "}
              <button
                type="button"
                className="linkish"
                disabled={busy}
                aria-expanded={pathOpen}
                onClick={() => setPathOpen((v) => !v)}
              >
                Open by path
              </button>
            </p>
          )}

        </div>
      </main>

      {/* "Open by path" — the escape hatch for what the native folder dialog
          can't select (a drive root as the vault, #75). */}
      {pathOpen && (
        <div className="modal-backdrop" onClick={closePathOpen}>
          <div
            className="modal open-by-path-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span>Open by path</span>
              <button className="icon-btn" aria-label="Close" onClick={closePathOpen}>
                ✕
              </button>
            </div>
            <form
              className="open-by-path"
              onSubmit={(e) => {
                e.preventDefault();
                void openByPath();
              }}
            >
              <p className="open-by-path-hint">
                Type the full path of a folder of <code>.md</code> files. This
                also works for a drive root or mounted volume the folder picker
                can't select, like <code>D:\</code> or <code>/Volumes/Notes</code>.
              </p>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                autoFocus
                value={manualPath}
                disabled={busy}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closePathOpen();
                }}
                placeholder="Folder path"
                spellCheck={false}
                autoComplete="off"
              />
              {pathError && <div className="auth-error">{pathError}</div>}
              <div className="open-by-path-actions">
                <button
                  type="button"
                  className="ghost-pill"
                  disabled={busy}
                  onClick={closePathOpen}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`primary${busy ? " is-busy" : ""}`}
                  disabled={busy || !manualPath.trim()}
                  aria-busy={busy || undefined}
                >
                  <span className="async-btn-label">{busy ? "Opening…" : "Open"}</span>
                  {busy && <Spinner size="xs" tone="on-accent" />}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {signInOpen && !authPrompt && (
        <Suspense fallback={null}>
          <AuthDialog
            // Someone arriving with a join code most likely has no account yet.
            initialMode={signInFor === "join" ? "sign-up" : "sign-in"}
            // Success: for the "open" route, keep the pending open target — the
            // store's post-sign-in landing opens exactly that vault, so just
            // dismiss. For the "join" route the landing was suppressed on
            // purpose, and this screen is still up: show the code step.
            onSignedIn={() => {
              setSignInOpen(false);
              if (signInFor === "join") setJoining(true);
            }}
            // Cancel: drop whichever intent sent us here, so a later sign-in from
            // elsewhere doesn't surprise-open a vault or strand itself waiting on
            // a code that is never coming.
            onClose={() => {
              if (signInFor === "join") cancelJoin();
              else requestOpenVault(null);
              setSignInOpen(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
