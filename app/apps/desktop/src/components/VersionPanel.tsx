import { useEffect, useRef, useState } from "react";
import { AsyncButton } from "./AsyncButton";
import { Face } from "./Face";
import {
  agoFromIso,
  formatVersionSize,
  nextActiveIndex,
  revertToastText,
  versionAuthorLabel,
  versionCauseLabel,
} from "./versionFormat";
import type { NoteVersion } from "../lib/api";
import { bridgeManager } from "../lib/bridge";
import { sha256Hex } from "../lib/bridge/adapter";
import { toast } from "../lib/toast";
import { useStore } from "../store";

/**
 * How long the preview survives the pointer leaving a row. Same 140ms the
 * editor's presence roster uses: long enough to cross the gap to the next row
 * (or to the Revert button) without the underlying editor flashing back to the
 * live text and then away again.
 */
const PREVIEW_GRACE_MS = 140;

/**
 * Version history is a dock body. Workspace PanelFrame owns its header and the
 * dock owns its reserved width; this component owns only history behavior.
 */
export function VersionPanel({ onRequestClose }: { onRequestClose: () => void }) {
  const docId = useStore((s) => s.versionPanelDocId);
  if (!docId) return null;
  return <VersionPanelBody key={docId} docId={docId} onRequestClose={onRequestClose} />;
}

function VersionPanelBody({
  docId,
  onRequestClose,
}: {
  docId: string;
  onRequestClose: () => void;
}) {
  const versions = useStore((s) => s.noteVersions);

  // Row 0 is the "Current" pseudo-entry; version i lives at index i + 1.
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // sha256 of the live buffer, so a stored version that still matches what's on
  // screen can say so instead of inviting a revert that would change nothing.
  const [liveSha, setLiveSha] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const graceRef = useRef<number | null>(null);

  const rows = versions ?? [];
  const rowCount = rows.length + 1;

  // Take focus so the arrow keys and Escape work without a second click.
  useEffect(() => {
    bodyRef.current?.focus({ preventScroll: true });
  }, []);

  // Relative times stay honest while the panel sits open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Track the live text's hash. Re-hashing on every keystroke would be silly, so
  // it settles for a beat first; the badge is a hint, not a lock.
  useEffect(() => {
    const bridge = bridgeManager.currentBridge();
    if (!bridge) return;
    let cancelled = false;
    let timer: number | null = null;
    const recompute = () => {
      const text = bridge.text.toString();
      void sha256Hex(text).then((hash) => {
        if (!cancelled) setLiveSha(hash);
      });
    };
    const onChange = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(recompute, 250);
    };
    recompute();
    bridge.text.observe(onChange);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      bridge.text.unobserve(onChange);
    };
  }, [docId, versions]);

  // Keep the keyboard selection visible when it walks off the viewport. Skipped
  // on mount: scrollIntoView scrolls every scrollable ancestor, and doing that
  // while the panel is still sliding in drags `.main` sideways mid-animation.
  const didMountScroll = useRef(false);
  useEffect(() => {
    if (!didMountScroll.current) {
      didMountScroll.current = true;
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const cancelGrace = () => {
    if (graceRef.current != null) {
      window.clearTimeout(graceRef.current);
      graceRef.current = null;
    }
  };

  // Leaving the panel must always drop the preview, including when the panel is
  // closed mid-hover — otherwise the editor is left showing a frozen old
  // version with nothing on screen explaining why.
  useEffect(
    () => () => {
      cancelGrace();
      useStore.getState().clearVersionPreview();
    },
    [],
  );

  const versionAt = (idx: number): NoteVersion | null => rows[idx - 1] ?? null;

  const previewRow = (idx: number) => {
    cancelGrace();
    const v = versionAt(idx);
    if (!v) {
      // Row 0 ("Current") is the way back to the live buffer.
      useStore.getState().clearVersionPreview();
      return;
    }
    void useStore.getState().previewVersion(v.id);
  };

  const scheduleClearPreview = () => {
    cancelGrace();
    graceRef.current = window.setTimeout(() => {
      graceRef.current = null;
      useStore.getState().clearVersionPreview();
    }, PREVIEW_GRACE_MS);
  };

  const close = () => {
    cancelGrace();
    onRequestClose();
  };

  const doRevert = async (v: NoteVersion) => {
    // Leave preview first: the revert lands in the LIVE editor as a forward
    // CRDT edit, and watching it apply under a read-only overlay would read as
    // nothing having happened.
    cancelGrace();
    useStore.getState().clearVersionPreview();
    try {
      await useStore.getState().revertToVersion(v.id);
      toast(revertToastText(v.createdAt, Date.now()), "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      e.preventDefault();
      return;
    }
    const next = nextActiveIndex(e.key, active, rowCount);
    if (next != null) {
      setActive(next);
      previewRow(next);
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      const v = versionAt(active);
      if (v) {
        void doRevert(v);
        e.preventDefault();
      }
    }
  };

  return (
    <div
      ref={bodyRef}
      className="version-panel-body"
      tabIndex={-1}
      aria-label="Version history"
      onKeyDown={onKeyDown}
    >
      <p className="muted version-panel-hint">
        Hover a version to preview it here. Reverting keeps a copy of the current
        text first, so you can always come back.
      </p>

      {versions == null ? (
        <div className="muted version-panel-empty">Loading…</div>
      ) : (
        <ul className="version-list" ref={listRef} onMouseLeave={scheduleClearPreview}>
          <li
            data-idx={0}
            className={`version-row current-row${active === 0 ? " active" : ""}`}
            onMouseEnter={() => {
              setActive(0);
              previewRow(0);
            }}
          >
            <span className="version-dot" aria-hidden="true" />
            <span className="version-row-main">
              <span className="version-row-title">Current</span>
              <span className="version-row-sub">What’s in the editor right now</span>
            </span>
          </li>
          {rows.map((v, i) => (
            <VersionRow
              key={v.id}
              version={v}
              idx={i + 1}
              active={active === i + 1}
              isCurrent={liveSha != null && liveSha === v.sha256}
              now={now}
              onHover={() => {
                setActive(i + 1);
                previewRow(i + 1);
              }}
              onRevert={() => doRevert(v)}
            />
          ))}
          {rows.length === 0 && (
            <li className="muted version-panel-empty">
              No versions yet. One is captured automatically a few minutes after
              you stop editing, and always just before a revert.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function VersionRow({
  version,
  idx,
  active,
  isCurrent,
  now,
  onHover,
  onRevert,
}: {
  version: NoteVersion;
  idx: number;
  active: boolean;
  /** This stored version's text is byte-identical to the live buffer. */
  isCurrent: boolean;
  now: number;
  onHover: () => void;
  onRevert: () => Promise<void>;
}) {
  const author = versionAuthorLabel(version.authorName);
  const size = formatVersionSize(version.size);
  return (
    <li
      data-idx={idx}
      className={`version-row${active ? " active" : ""}${isCurrent ? " is-current" : ""}`}
      onMouseEnter={onHover}
    >
      <Face
        seed={version.authorName || version.authorId || "?"}
        className="version-avatar"
        ariaHidden
      />
      <span className="version-row-main">
        <span className="version-row-title">
          {agoFromIso(version.createdAt, now)}
          {isCurrent && <span className="version-badge">Current</span>}
        </span>
        <span className="version-row-sub">
          {author} · {versionCauseLabel(version.cause)}
          {size && ` · ${size}`}
        </span>
      </span>
      <AsyncButton
        className="link-btn version-revert"
        disabled={isCurrent}
        title={
          isCurrent
            ? "This is already what the note says"
            : "Replace the note with this version"
        }
        onClick={onRevert}
      >
        Revert
      </AsyncButton>
    </li>
  );
}
