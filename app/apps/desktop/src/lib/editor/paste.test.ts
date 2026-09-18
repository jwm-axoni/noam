// @vitest-environment jsdom
//
// Paste routing helpers: distinguishing raw HTML *source* (→ a ```html preview
// fence) from prose, and building a safe fence around it.

import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createEditorState, presentationExtensions } from "./index";
import { fenceHtml, looksLikeHtmlSource } from "./paste";

const options = { getTitles: () => [], onNavigate: () => {} };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function imagePayload() {
  const file = {
    name: "image.png",
    type: "image/png",
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as File;
  return {
    file,
    data: {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => file,
        },
      ],
      files: [file],
      getData: () => "",
    } as unknown as DataTransfer,
  };
}

function mountWithSave(saveAttachment: (bytes: Uint8Array, ext: string) => Promise<string>) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const compartment = new Compartment();
  const view = new EditorView({
    state: createEditorState({
      doc: "body",
      ...options,
      saveAttachment,
      viewMode: { mode: "live", compartment },
    }),
    parent,
  });
  return { view, compartment };
}

function imageEvent(type: "paste" | "drop", data: DataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: data,
  });
  Object.defineProperty(event, "clientX", { value: 0 });
  Object.defineProperty(event, "clientY", { value: 0 });
  return event;
}

describe("looksLikeHtmlSource", () => {
  it("detects a full HTML document", () => {
    expect(
      looksLikeHtmlSource("<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>")
    ).toBe(true);
  });

  it("detects an HTML fragment", () => {
    expect(looksLikeHtmlSource("<div class=\"x\">hello</div>")).toBe(true);
    expect(looksLikeHtmlSource("  <p>indented</p>")).toBe(true);
    expect(looksLikeHtmlSource("<br>")).toBe(true);
    expect(looksLikeHtmlSource("<!-- a comment -->")).toBe(true);
  });

  it("does NOT flag prose that merely contains angle brackets", () => {
    expect(looksLikeHtmlSource("a < b and c > d")).toBe(false);
    expect(looksLikeHtmlSource("email me <at> nowhere")).toBe(false);
    expect(looksLikeHtmlSource("just some text")).toBe(false);
    expect(looksLikeHtmlSource("")).toBe(false);
  });

  it("does NOT flag Markdown that starts with a wikilink or heading", () => {
    expect(looksLikeHtmlSource("[[Welcome]]")).toBe(false);
    expect(looksLikeHtmlSource("# Heading")).toBe(false);
  });
});

describe("fenceHtml", () => {
  it("wraps HTML in a ```html fence", () => {
    expect(fenceHtml("<h1>Hi</h1>")).toBe("```html\n<h1>Hi</h1>\n```");
  });

  it("trims a single trailing newline before closing the fence", () => {
    expect(fenceHtml("<h1>Hi</h1>\n")).toBe("```html\n<h1>Hi</h1>\n```");
  });

  it("uses a longer fence when the source itself contains backticks", () => {
    const src = "<p>```</p>";
    const out = fenceHtml(src);
    expect(out.startsWith("````html\n")).toBe(true);
    expect(out.endsWith("\n````")).toBe(true);
    expect(out).toContain(src);
  });
});

describe("pending image embeds", () => {
  for (const kind of ["paste", "drop"] as const) {
    it(`cancels a deferred ${kind} after crossing into Reading`, async () => {
      const saved = deferred<string>();
      const save = vi.fn(() => saved.promise);
      const { view, compartment } = mountWithSave(save);
      if (kind === "drop") vi.spyOn(view, "posAtCoords").mockReturnValue(0);
      const { data } = imagePayload();
      view.contentDOM.dispatchEvent(imageEvent(kind, data));
      await Promise.resolve();
      expect(save).toHaveBeenCalledOnce();

      view.dispatch({
        effects: compartment.reconfigure(presentationExtensions("reading", options)),
      });
      // The policy is session-based: returning to editable before the save
      // resolves does not revive an insert initiated in the previous session.
      view.dispatch({
        effects: compartment.reconfigure(presentationExtensions("live", options)),
      });
      saved.resolve("attachments/image.png");
      await Promise.resolve();
      await Promise.resolve();
      expect(view.state.doc.toString()).toBe("body");
      view.destroy();
    });
  }

  it("does not dispatch into a destroyed view when attachment saving finishes", async () => {
    const saved = deferred<string>();
    const { view } = mountWithSave(() => saved.promise);
    const { data } = imagePayload();
    view.contentDOM.dispatchEvent(imageEvent("paste", data));
    await Promise.resolve();
    view.destroy();
    saved.resolve("attachments/image.png");
    await Promise.resolve();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("body");
  });
});
