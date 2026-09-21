import { describe, expect, it, vi } from "vitest";
import { pageFromFragment, sourceWithoutFragment } from "./PdfViewer";
import { parseCsv, structuredPreviewTest } from "./StructuredPreview";

describe("PDF navigation", () => {
  it("reads page links without sending the fragment to PDF.js", () => {
    const source = "asset:/vault/Annual Report.pdf?token=one#page=12";
    expect(pageFromFragment(source)).toBe(12);
    expect(sourceWithoutFragment(source)).toBe("asset:/vault/Annual Report.pdf?token=one");
  });

  it("falls back to the first page for invalid links", () => {
    expect(pageFromFragment("report.pdf#page=0")).toBe(1);
    expect(pageFromFragment("report.pdf#other=2")).toBe(1);
    expect(pageFromFragment("report.pdf?download=1&page=7")).toBe(1);
    expect(pageFromFragment("report.pdf#page=7nope")).toBe(1);
    expect(pageFromFragment("report.pdf#page%3D7")).toBe(7);
    expect(pageFromFragment("report.pdf#page=%AA")).toBe(1);
  });
});

describe("CSV preview", () => {
  it("keeps commas and quotes inside quoted fields", () => {
    expect(parseCsv('name,note\nAda,"one, two"\nLin,"said ""hi"""')).toEqual([
      ["name", "note"],
      ["Ada", "one, two"],
      ["Lin", 'said "hi"'],
    ]);
  });
});

describe("bounded structured preview", () => {
  it("does not truncate a response whose body is exactly one MiB", async () => {
    const source = "x".repeat(1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source)));
    await expect(structuredPreviewTest.readBoundedText("asset:/exact.txt")).resolves.toEqual({
      text: source,
      truncated: false,
    });
    vi.unstubAllGlobals();
  });
});
