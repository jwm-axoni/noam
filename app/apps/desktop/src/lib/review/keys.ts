// The single-key review grammar: `]` / `[` move, `A` accepts, `R` rejects,
// Escape leaves the focus session.
//
// Single letters are only safe where nobody is typing. The mocks guarded
// INPUT/SELECT/TEXTAREA, but the note editor is CodeMirror — a contenteditable
// div — so an `a` typed into a note would have accepted a suggestion. The rule
// here is positive, not negative: the keys fire ONLY when focus sits inside a
// review zone (`data-review-zone` = rail | bar | chips | session), and even
// then never from a text-editing target.

export type ReviewFocusContext = "rail" | "bar" | "chips" | "session";
export type ReviewKeyActionName = "next" | "prev" | "accept" | "reject" | "leave";

/** The subset of a KeyboardEvent this decision reads (so tests can fake it). */
export interface ReviewKeyEvent {
  key: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
}

const ZONES: readonly string[] = ["rail", "bar", "chips", "session"];

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === "function" ? (target as Element) : null;
}

/** Which review zone (if any) contains `el`. */
export function focusContextOf(target: EventTarget | null): ReviewFocusContext | null {
  const zone = asElement(target)?.closest("[data-review-zone]")?.getAttribute("data-review-zone");
  return zone && ZONES.includes(zone) ? (zone as ReviewFocusContext) : null;
}

/** True when a keystroke on `target` would edit text. */
function isTextEditing(target: EventTarget | null): boolean {
  const el = asElement(target);
  if (!el) return false;
  if (el.closest(".cm-editor")) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // jsdom does not implement isContentEditable; walk the attribute too.
  const ce = el.closest("[contenteditable]");
  if (ce && ce.getAttribute("contenteditable") !== "false") return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function reviewKeyAction(
  event: ReviewKeyEvent,
  focusContext: ReviewFocusContext | null,
): ReviewKeyActionName | null {
  if (focusContext === null) return null;
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTextEditing(event.target)) return null;

  switch (event.key) {
    case "]":
      return "next";
    case "[":
      return "prev";
    case "a":
    case "A":
      return event.repeat ? null : "accept";
    case "r":
    case "R":
      return event.repeat ? null : "reject";
    case "Escape":
      return focusContext === "session" ? "leave" : null;
    default:
      return null;
  }
}
