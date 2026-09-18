import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  containSettingsBackground,
  containSettingsNestedFocus,
  containSettingsTab,
  settingsReturnFocusTarget,
  topSettingsNestedDialog,
  topSettingsNestedSurface,
} from "./settings/focusContainment";

/**
 * Portalled modal shell for the unified settings surface. Compatibility entry
 * points for the former account and vault dialogs both render through this
 * shell, so focus ownership and nested-dialog precedence stay centralized.
 *
 * Portalled to `<body>` for the same reason `UpgradeDialog` is: settings is
 * mounted from `AccountMenu`, a leaf of `.sidebar-footer`, and a fixed backdrop
 * rendered there is one `transform`/`filter` on an ancestor away from being
 * clipped to a sidebar-sized box.
 *
 * The card keeps the `.settings-page` class — input/select styling is
 * descendant-scoped on it in `styles/settings.css` — and adds `.settings-modal` for the
 * card geometry. It animates **opacity only**, deliberately: a transform (even
 * a settled `translateY(0)` left behind by `rise-in`'s `both` fill) makes the
 * card a containing block and would trap the `position: fixed` dialogs the tab
 * bodies render, e.g. the revert-checkpoint confirm in Versioning.
 *
 * The backdrop *is* a containing block for those dialogs — `.modal-backdrop`
 * carries `backdrop-filter`, which creates one — but it is `position: fixed;
 * inset: 0` with no clipping, so a fixed child sized to it is still sized to
 * the viewport. Keep it that way: give this backdrop an inset or an
 * `overflow: hidden` and every nested dialog shrinks to it.
 */
export function SettingsModal({
  label,
  onClose,
  children,
}: {
  /** Accessible name for the dialog, e.g. "Settings — My Vault". */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const releaseBackgroundRef = useRef<(() => void) | null>(null);
  /**
   * Did the press that produced this click start on the backdrop? Selecting
   * text in a field and releasing outside the card fires `click` on the
   * backdrop (it is the common ancestor), and losing your settings to a
   * text-selection drag would be maddening. Only a press *and* release on the
   * backdrop counts as clicking away.
   */
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const portal = cardRef.current?.parentElement;
    if (!portal) return;
    const release = containSettingsBackground(portal);
    releaseBackgroundRef.current = release;
    return () => {
      release();
      if (releaseBackgroundRef.current === release) releaseBackgroundRef.current = null;
    };
  }, []);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    return containSettingsNestedFocus(card);
  }, []);

  // Focus the way out on open, and hand focus back to whatever opened us on
  // close. Popover rows disappear as they open settings, so the identity bar
  // is their explicit connected fallback.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const target =
      card?.querySelector<HTMLElement>(".settings-page-header .icon-btn") ??
      card?.querySelector<HTMLElement>(".settings-nav-item") ??
      card;
    target?.focus();
    return () => {
      // React's effect-cleanup order is not part of focus ownership. Release
      // inertness explicitly before returning focus even if this cleanup runs
      // before the background effect's cleanup.
      releaseBackgroundRef.current?.();
      releaseBackgroundRef.current = null;
      const returnTarget = settingsReturnFocusTarget(previous);
      returnTarget?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Anything opened from *inside* settings owns Esc first: a dialog stacked
      // above us (Upgrade, Sign in, a confirm — each renders a
      // `.modal-backdrop`) or an open popover (`MenuSelect`'s role menus render
      // a portalled `.context-menu`). One of those on screen means we are not
      // the topmost surface, and closing the whole modal out from under it is
      // never what the key was for.
      const nestedSurface = topSettingsNestedSurface();
      if (e.key === "Escape") {
        if (nestedSurface) return;
        onClose();
        return;
      }
      const card = cardRef.current;
      if (card) containSettingsTab(e, topSettingsNestedDialog() ?? card);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop settings-backdrop"
      // Not stopped by the card, so a press anywhere inside it reaches here
      // with `target !== currentTarget` and correctly clears the flag.
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const away = e.target === e.currentTarget && pressedBackdrop.current;
        pressedBackdrop.current = false;
        if (away) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="settings-page settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
