import { lazy, Suspense, useEffect, useState } from "react";
import { authManager } from "../lib/auth/authManager";
import { normalizeServerUrl, serverHost } from "../lib/auth/serverChoice";
import {
  ACTIVITY_STATUSES,
  type ActivityStatus,
  writeServerChoice,
} from "../lib/prefs";
import { currentVersion } from "../lib/updater";
import { useStore } from "../store";
import { Avatar } from "./Avatar";
import { serverFailureMessage } from "./serverFailureMessage";
import { Switch } from "./Switch";
import type { SettingsSectionId } from "./settings/settingsRegistry";

/** Account-backed section bodies plus the former dialog's compatibility entry. */

const UnifiedSettingsDialog = lazy(() =>
  import("./settings/SettingsDialog").then((module) => ({
    default: module.SettingsDialog,
  })),
);

export function AccountSettings({ onClose }: { onClose: () => void }) {
  const session = useStore((s) => s.session);
  if (!session) return null;
  return (
    <Suspense fallback={null}>
      <UnifiedSettingsDialog initialSection="profile" onClose={onClose} />
    </Suspense>
  );
}

export type AccountSettingsSectionId = Extract<
  SettingsSectionId,
  "profile" | "status" | "notifications" | "connection" | "about"
>;

export function AccountSettingsSection({
  section,
  onClose,
}: {
  section: AccountSettingsSectionId;
  onClose: () => void;
}) {
  const session = useStore((state) => state.session);
  if (section !== "about" && !session) return null;
  switch (section) {
    case "profile":
      return <ProfileTab />;
    case "status":
      return <StatusTab />;
    case "notifications":
      return <NotificationsTab />;
    case "connection":
      return <ConnectionTab />;
    case "about":
      return <AboutTab onClose={onClose} />;
  }
}

function ProfileTab() {
  const session = useStore((s) => s.session);
  const [name, setName] = useState(session?.user.name ?? "");
  const [image, setImage] = useState(session?.user.image ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(session?.user.name ?? "");
    setImage(session?.user.image ?? "");
  }, [session?.user.name, session?.user.image]);

  if (!session) return null;
  const trimmedName = name.trim();
  const trimmedImage = image.trim();
  const dirty =
    trimmedName !== (session.user.name ?? "") ||
    trimmedImage !== (session.user.image ?? "");

  // Re-sending the confirmation email: its own tiny state so a failure (this
  // server has no email; the provider refused) is said next to the button.
  const [resendBusy, setResendBusy] = useState(false);
  const [resendState, setResendState] = useState<string | null>(null);
  const resendConfirmation = async () => {
    setResendBusy(true);
    setResendState(null);
    try {
      await useStore.getState().resendVerificationEmail();
      setResendState("sent");
    } catch (e) {
      setResendState(e instanceof Error ? e.message : String(e));
    } finally {
      setResendBusy(false);
    }
  };

  const save = async () => {
    if (!trimmedName) {
      setError("Name can't be empty.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await useStore.getState().updateProfile({
        name: trimmedName,
        image: trimmedImage || null,
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-profile">
      <div className="profile-hero">
        <Avatar label={trimmedName || session.user.email} image={trimmedImage || null} />
        <div className="profile-hero-meta">
          <strong>{trimmedName || "—"}</strong>
          <span className="muted">{session.user.email}</span>
        </div>
      </div>

      <label className="field" data-setting-id="display-name" tabIndex={-1}>
        <span className="field-label">Display name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoComplete="name"
        />
      </label>

      <label className="field" data-setting-id="avatar" tabIndex={-1}>
        <span className="field-label">Avatar image URL</span>
        <input
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="https://…/photo.jpg"
          spellCheck={false}
        />
        <span className="field-hint">
          Paste a link to a photo. Leave blank to use your generated character avatar.
        </span>
      </label>

      <label className="field" data-setting-id="email" tabIndex={-1}>
        <span className="field-label">Email</span>
        <input value={session.user.email} disabled readOnly />
        {/* Verification state, live: the confirmation link bounces back into
            the app (`noam://verified`), which re-reads the session, so this
            flips without a reload. `emailVerified` is absent on very old
            servers — say nothing rather than "not confirmed" then. */}
        {session.user.emailVerified === true && (
          <span className="field-hint">Email confirmed ✓</span>
        )}
        {session.user.emailVerified === false && (
          <span className="field-hint">
            Not confirmed yet — check your inbox for the confirmation email.{" "}
            <button
              type="button"
              className="linkish"
              disabled={resendBusy}
              onClick={() => void resendConfirmation()}
            >
              {resendBusy ? "Sending…" : resendState === "sent" ? "Sent ✓" : "Resend it"}
            </button>
            {resendState && resendState !== "sent" && (
              <span className="update-status error"> {resendState}</span>
            )}
          </span>
        )}
      </label>

      {error && <div className="auth-error">{error}</div>}

      <div className="update-actions">
        <button className="primary sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy && <span className="btn-spinner" aria-hidden="true" />}
          <span>Save changes</span>
        </button>
        {saved && (
          <span className="update-status" role="status">
            Saved.
          </span>
        )}
      </div>
    </div>
  );
}

function StatusTab() {
  const activityStatus = useStore((s) => s.activityStatus);

  return (
    <div className="status-tab" data-setting-id="activity-status" tabIndex={-1}>
      <p className="muted">
        Your status shows next to your cursor for teammates working in the same note.
      </p>
      <div className="status-options">
        {ACTIVITY_STATUSES.map((s) => {
          const active = s.id === activityStatus;
          return (
            <button
              key={s.id}
              type="button"
              className={`menu-item${active ? " active" : ""}`}
              role="menuitemradio"
              aria-checked={active}
              onClick={() => useStore.getState().setActivityStatus(s.id as ActivityStatus)}
            >
              <span className={`status-dot ${s.id}`} aria-hidden="true" />
              <span className="menu-item-label">
                {s.label}
                <span className="field-hint">{s.hint}</span>
              </span>
              {active && (
                <svg
                  className="menu-check"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NotificationsTab() {
  const mentionSound = useStore((s) => s.mentionSound);
  return (
    <label className="menu-row toggle-row" data-setting-id="mention-chime" tabIndex={-1}>
      <span className="menu-row-label">
        Mention chime
        <span className="field-hint">Play a sound when a teammate pings you.</span>
      </span>
      <Switch
        checked={mentionSound}
        ariaLabel="Mention chime"
        onChange={(next) => useStore.getState().setMentionSound(next)}
      />
    </label>
  );
}

function ConnectionTab() {
  const serverUrl = useStore((s) => s.serverUrl);
  const [draft, setDraft] = useState(serverUrl);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(serverUrl), [serverUrl]);

  /**
   * Check the address answers BEFORE adopting it. Changing the server is a
   * de-facto sign-out (the session lives under a per-server keychain key), so a
   * typo used to swap a working session for a signed-out app and no message at
   * all — `save` had a `finally` and no `catch`.
   */
  const save = async () => {
    const url = normalizeServerUrl(draft);
    if (!url) {
      setError("That doesn't look like a server address — try https://notes.example.com");
      return;
    }
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await authManager.api.health(url);
      // Every user self-hosts, so any address saved here is a deliberate
      // self-host answer.
      writeServerChoice("custom");
      await useStore.getState().setServerUrl(url);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(serverFailureMessage(e, url));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection-tab">
      <label className="field" data-setting-id="server-url" tabIndex={-1}>
        <span className="field-label">Server URL</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://notes.example.com"
          spellCheck={false}
          autoCapitalize="off"
        />
        <span className="field-hint">
          Your Noam server's address — currently{" "}
          <strong>{serverHost(serverUrl)}</strong>. Your account is per-server,
          so switching signs you in to that server's session instead.
        </span>
      </label>
      <div className="update-actions">
        <button
          className="primary sm"
          disabled={busy || draft.trim() === serverUrl}
          onClick={() => void save()}
        >
          {busy && <span className="btn-spinner" aria-hidden="true" />}
          <span>Save &amp; reconnect</span>
        </button>
        {saved && (
          <span className="update-status" role="status">
            Reconnected.
          </span>
        )}
      </div>
      {error && <div className="auth-error">{error}</div>}
    </div>
  );
}

function AboutTab({ onClose }: { onClose: () => void }) {
  const session = useStore((state) => state.session);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void currentVersion().then(setVersion);
  }, []);

  return (
    <div className="about-tab">
      <div className="menu-row" data-setting-id="app-version" tabIndex={-1}>
        <span className="menu-row-label">Current version</span>
        <span className="mono">{version ?? "…"}</span>
      </div>

      {session && (
        <>
          <div className="menu-sep" />
          <button
            className="menu-item danger"
            data-setting-id="sign-out"
            onClick={() => {
              onClose();
              void useStore.getState().signOut();
            }}
          >
            <Icon>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </Icon>
            <span className="menu-item-label">Sign out</span>
          </button>
        </>
      )}
    </div>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="menu-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export { AccountSettings as default };
