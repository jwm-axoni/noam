import { useEffect, useId, useRef, useState } from "react";
import { authManager } from "../lib/auth/authManager";
import {
  type Permission,
  type Share,
  sharePrincipalId,
} from "../lib/api";
import { useStore } from "../store";
import { Avatar } from "./Avatar";
import {
  containSettingsTab,
  focusableSettingsElements,
  topSettingsNestedDialog,
  topSettingsNestedSurface,
} from "./settings/focusContainment";

export interface ShareTarget {
  resourceType: "folder" | "file";
  resourceId: string;
  title: string;
}

/**
 * Folder/file share dialog (spec 04 §3/§6): grant a member view/edit, list
 * existing shares, revoke. Folder shares are inherited by descendants per the
 * server ACL; revoke force-disconnects live sockets server-side (instant kill).
 */
export function ShareDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const members = useStore((s) => s.members);
  const session = useStore((s) => s.session);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  const [shares, setShares] = useState<Share[]>([]);
  const [principalId, setPrincipalId] = useState("");
  const [permission, setPermission] = useState<Permission>("view");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shareableMembers = members.filter((m) => m.userId !== session?.user.id);

  const load = async () => {
    try {
      const list = await authManager.api.listShares(target.resourceType, target.resourceId);
      setShares(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    if (shareableMembers.length > 0 && !principalId) {
      setPrincipalId(shareableMembers[0].userId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.resourceId]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const initial = dialog ? focusableSettingsElements(dialog)[0] ?? dialog : null;
    initial?.focus();
    return () => {
      if (
        previous?.isConnected &&
        previous !== document.body &&
        previous !== document.documentElement
      ) {
        previous.focus();
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const backdrop = backdropRef.current;
      const dialog = dialogRef.current;
      if (!backdrop || !dialog) return;

      if (event.key === "Escape") {
        // A menu or dialog opened from Share owns Escape first. The backdrop
        // is included in the shared selector, so only a different top surface
        // blocks this dialog from closing.
        const topSurface = topSettingsNestedSurface();
        if (topSurface && topSurface !== backdrop) return;
        event.preventDefault();
        onClose();
        return;
      }

      const topDialog = topSettingsNestedDialog();
      containSettingsTab(
        event,
        topDialog && topDialog !== backdrop ? topDialog : dialog,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const addShare = async () => {
    if (!principalId) return;
    setBusy(true);
    setError(null);
    try {
      await authManager.api.createShare({
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        principalId,
        permission,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (shareId: string) => {
    setBusy(true);
    try {
      await authManager.api.revokeShare(shareId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const memberName = (userId: string) => {
    const m = members.find((mm) => mm.userId === userId);
    return m?.user?.name || m?.user?.email || userId;
  };

  return (
    <div ref={backdropRef} className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span id={titleId}>
            Share <strong>{target.title}</strong>
            <span className="muted"> ({target.resourceType})</span>
          </span>
          <button
            className="icon-btn"
            aria-label="Close share dialog"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="share-add">
          <select value={principalId} onChange={(e) => setPrincipalId(e.target.value)}>
            {shareableMembers.length === 0 && <option value="">No other members</option>}
            {shareableMembers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.user?.name || m.user?.email || m.userId}
              </option>
            ))}
          </select>
          <select value={permission} onChange={(e) => setPermission(e.target.value as Permission)}>
            <option value="view">view</option>
            <option value="edit">edit</option>
          </select>
          <button
            className="primary"
            disabled={busy || !principalId}
            onClick={() => void addShare()}
          >
            Share
          </button>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="subhead">People with access</div>
        {shares.length === 0 ? (
          <div className="muted">Not shared with anyone yet.</div>
        ) : (
          <ul className="share-list">
            {shares.map((s) => {
              const name = memberName(sharePrincipalId(s));
              return (
                <li key={s.id}>
                  <Avatar label={name} />
                  <span className="member-name">{name}</span>
                  <span className="member-role">{s.permission}</span>
                  <button className="link-btn danger" onClick={() => void revoke(s.id)}>
                    Revoke
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
