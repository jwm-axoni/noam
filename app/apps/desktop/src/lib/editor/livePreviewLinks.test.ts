// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditorState } from "./index";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
});

const views: EditorView[] = [];

afterEach(() => {
  while (views.length > 0) views.pop()?.destroy();
  document.body.replaceChildren();
});

function mount(doc: string, onOpenLink: (href: string) => void): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      onOpenLink,
    }),
    parent,
  });
  views.push(view);
  return view;
}

describe("ordinary Markdown link activation", () => {
  it("hands the exact destination to the app link router", () => {
    const onOpenLink = vi.fn();
    const view = mount("[JSON data](attachments/Sample%20data.json#row-2)", onOpenLink);
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");
    expect(link).not.toBeNull();
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    link!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      "attachments/Sample%20data.json#row-2",
    );
  });
});
