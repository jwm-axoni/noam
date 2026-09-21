// SPDX-License-Identifier: Apache-2.0

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
].join(",");

const NESTED_SURFACE_SELECTOR =
  ".modal-backdrop:not(.settings-backdrop), .context-menu";

const NESTED_DIALOG_SELECTOR = ".modal-backdrop:not(.settings-backdrop)";

export function focusableSettingsElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]"),
  );
}

export function settingsSearchFocusTarget(
  section: HTMLElement,
  settingId: string | null,
): { scrollTarget: HTMLElement; focusTarget: HTMLElement } | null {
  const title = section.querySelector<HTMLElement>(".settings-section-title");
  if (!settingId) {
    return title ? { scrollTarget: title, focusTarget: title } : null;
  }

  const setting = Array.from(
    section.querySelectorAll<HTMLElement>("[data-setting-id]"),
  ).find((element) => element.dataset.settingId === settingId);
  if (!setting) {
    return title ? { scrollTarget: title, focusTarget: title } : null;
  }
  return {
    scrollTarget: setting,
    focusTarget: focusableSettingsElements(setting)[0] ?? setting,
  };
}

export function settingsReturnFocusTarget(previous: HTMLElement | null): HTMLElement | null {
  if (
    previous?.isConnected &&
    previous !== document.body &&
    previous !== document.documentElement
  ) {
    return previous;
  }
  return document.querySelector<HTMLElement>("[data-settings-return-focus]");
}

/** Returns true when the event was contained and its default was prevented. */
export function containSettingsTab(event: KeyboardEvent, container: HTMLElement): boolean {
  if (event.key !== "Tab") return false;
  const focusable = focusableSettingsElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return true;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (!container.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }

  // Search can land focus on a programmatic target — a tabIndex={-1} row or
  // heading that sits outside the sequential tab order (and so does the
  // dialog card itself). A Tab from there must enter the tab order inside
  // the container rather than letting native focus escape past it.
  if (active instanceof HTMLElement && !focusable.includes(active)) {
    event.preventDefault();
    let candidate: HTMLElement | null = null;
    for (const element of focusable) {
      const position = active.compareDocumentPosition(element);
      if (event.shiftKey) {
        // Nearest tabbable element before the target; wrap to the end.
        if (position & Node.DOCUMENT_POSITION_PRECEDING) candidate = element;
      } else if (!candidate && position & Node.DOCUMENT_POSITION_FOLLOWING) {
        candidate = element;
      }
    }
    (candidate ?? (event.shiftKey ? last : first)).focus();
    return true;
  }
  return false;
}

export function topSettingsNestedSurface(): HTMLElement | null {
  const surfaces = document.querySelectorAll<HTMLElement>(NESTED_SURFACE_SELECTOR);
  return surfaces.item(surfaces.length - 1);
}

export function topSettingsNestedDialog(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>(NESTED_DIALOG_SELECTOR);
  return dialogs.item(dialogs.length - 1);
}

/**
 * Move focus into a dialog opened above settings, then return it to the
 * settings control that launched the dialog when that layer disappears.
 * Popover menus intentionally retain focus on their trigger.
 */
export function containSettingsNestedFocus(container: HTMLElement): () => void {
  let nestedDialog: HTMLElement | null = null;
  let returnTarget: HTMLElement | null = null;

  const sync = () => {
    const nextDialog = topSettingsNestedDialog();
    if (nextDialog === nestedDialog) return;

    if (nextDialog) {
      if (!nestedDialog) {
        const active = document.activeElement;
        returnTarget =
          active instanceof HTMLElement && container.contains(active) ? active : null;
      }
      nestedDialog = nextDialog;
      const target = focusableSettingsElements(nextDialog)[0];
      target?.focus();
      return;
    }

    if (nestedDialog) {
      nestedDialog = null;
      const target = returnTarget?.isConnected ? returnTarget : container;
      returnTarget = null;
      target.focus();
    }
  };

  const observer = new MutationObserver(sync);
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
  return () => observer.disconnect();
}

/**
 * Make every body-level app surface except the settings portal inert. The
 * exact prior attribute state is restored so a parent modal can keep owning
 * its own background when settings is closed.
 */
export function containSettingsBackground(portal: HTMLElement): () => void {
  const previous = new Map<HTMLElement, boolean>();
  const sync = () => {
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement) || child === portal) continue;
      if (!previous.has(child)) previous.set(child, child.hasAttribute("inert"));

      // AuthDialog is mounted inside the app root, whereas confirmations and
      // upgrade dialogs may be descendants of settings or body-level portals.
      // A body child hosting the active nested layer must not inherit the
      // settings background's inertness. The focus trap still keeps the rest
      // of that host unreachable by keyboard.
      const hostsNestedSurface =
        child.matches(NESTED_SURFACE_SELECTOR) ||
        child.querySelector(NESTED_SURFACE_SELECTOR) !== null;
      if (hostsNestedSurface && previous.get(child) === false) {
        child.removeAttribute("inert");
      } else {
        child.setAttribute("inert", "");
      }
    }
  };

  const observer = new MutationObserver(sync);
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
  return () => {
    observer.disconnect();
    for (const [element, wasInert] of previous) {
      if (!element.isConnected) continue;
      if (wasInert) element.setAttribute("inert", "");
      else element.removeAttribute("inert");
    }
  };
}
