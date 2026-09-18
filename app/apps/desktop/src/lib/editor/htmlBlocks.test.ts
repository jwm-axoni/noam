// Verifies the core assumption behind live-preview HTML embedding: a Markdown
// file with HTML mixed in parses into discrete `HTMLBlock` nodes (which the
// livePreview plugin renders inline) while the surrounding Markdown stays
// Markdown. Runs at the parser level so it needs no DOM.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";

/** Collect the text of every top-level `HTMLBlock` in a document. */
function htmlBlocks(doc: string): string[] {
  const tree = markdown({ base: markdownLanguage }).language.parser.parse(doc);
  const blocks: string[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === "HTMLBlock") blocks.push(doc.slice(node.from, node.to));
    },
  });
  return blocks;
}

describe("HTML embedded in markdown", () => {
  it("recognizes a standalone HTML element block between markdown", () => {
    const doc = [
      "# Title",
      "",
      "<img src=\"https://example.com/pic.png\" alt=\"pic\">",
      "",
      "Some **markdown** text after the image.",
    ].join("\n");

    const blocks = htmlBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("<img");
  });

  it("keeps a multi-line HTML fragment as one block", () => {
    const doc = [
      "Intro paragraph.",
      "",
      "<div class=\"card\">",
      "  <h2>Boxed heading</h2>",
      "  <p>Caption</p>",
      "</div>",
      "",
      "## A real markdown heading",
    ].join("\n");

    const blocks = htmlBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("<div");
    expect(blocks[0]).toContain("</div>");
    // The markdown heading below must NOT be swallowed into the HTML block.
    expect(blocks[0]).not.toContain("A real markdown heading");
  });

  it("captures a pasted full HTML document as HTML block(s)", () => {
    const doc = [
      "<!DOCTYPE html>",
      "<html>",
      "<title>HTML Tutorial</title>",
      "<body>",
      "<h1>This is a heading</h1>",
      "<p>This is a paragraph.</p>",
      "</body>",
      "</html>",
    ].join("\n");

    // CommonMark splits `<!DOCTYPE …>` off as its own block (it sanitizes to
    // nothing); the document body lands in the following block. What matters is
    // the whole paste is HTML — no line leaks out as markdown — and the heading
    // is rendered from the body block.
    const blocks = htmlBlocks(doc);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.join("\n")).toContain("<h1>This is a heading</h1>");
    expect(blocks.join("\n")).toContain("This is a paragraph.");
  });

  it("finds no HTML block in pure markdown", () => {
    const doc = "# Heading\n\nJust **bold** and _italic_ and a [link](https://x.com).";
    expect(htmlBlocks(doc)).toHaveLength(0);
  });
});
