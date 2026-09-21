import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset:${path}`,
}));

import {
  openMarkdownLink,
  resolveVaultAsset,
  resolveVaultReference,
} from "./assetResolver";

describe("vault asset resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves spaces and Unicode relative to the owning document", () => {
    expect(resolveVaultAsset({
      vaultPath: "/Vault Root",
      documentPath: "笔记/Today.md",
      source: "../媒体/cover photo.png#focus",
    })).toBe("asset:/Vault Root/媒体/cover photo.png#focus");
  });

  it("keeps root-relative query and page fragments", () => {
    expect(resolveVaultAsset({
      vaultPath: "/vault",
      documentPath: "nested/note.md",
      source: "/attachments/report.pdf?download=1#page=12",
    })).toBe("asset:/vault/attachments/report.pdf?download=1#page=12");
  });

  it("decodes Markdown spaces and Unicode exactly once before native encoding", () => {
    expect(resolveVaultAsset({ vaultPath: "/vault", documentPath: "note.md",
      source: "attachments/Preview%20caf%C3%A9%20%E4%BD%A0%E5%A5%BD.pdf#page=2",
    })).toBe("asset:/vault/attachments/Preview café 你好.pdf#page=2");
    expect(resolveVaultAsset({ vaultPath: "/vault", documentPath: "note.md", source: "100%2520.pdf" }))
      .toBe("asset:/vault/100%20.pdf");
  });

  it("preserves literal filename punctuation for metadata and file-tree paths", () => {
    expect(resolveVaultAsset({
      vaultPath: "/vault",
      documentPath: "",
      source: "attachments/项目 50% #1?.png",
      sourceKind: "path",
    })).toBe("asset:/vault/attachments/项目 50% #1?.png");
    expect(resolveVaultAsset({ vaultPath: "/vault", documentPath: "nested/note.md", source: "attachments/icon.png", sourceKind: "path" }))
      .toBe("asset:/vault/attachments/icon.png");
    expect(resolveVaultAsset({ vaultPath: "/vault", documentPath: "", source: "attachments/../icon.png", sourceKind: "path" }))
      .toBe("asset:/vault/icon.png");
    expect(resolveVaultAsset({ vaultPath: "/vault", documentPath: "", source: "../outside.png", sourceKind: "path" }))
      .toBe("");
  });

  it("normalizes encoded traversal and rejects encoded separators or NUL", () => {
    expect(resolveVaultAsset({ vaultPath: "/vault", documentPath: "nested/n.md", source: "%2e%2e/a.pdf" }))
      .toBe("asset:/vault/a.pdf");
    for (const source of ["%2e%2e%2foutside.pdf", "a%5cb.pdf", "a%00.pdf"]) {
      expect(resolveVaultAsset({ vaultPath: "/vault", documentPath: "n.md", source })).toBe("");
    }
  });

  it("cannot climb above the vault root", () => {
    expect(resolveVaultAsset({
      vaultPath: "/vault",
      documentPath: "note.md",
      source: "../../outside.png",
    })).toBe("");
  });

  it("does not rewrite remote, data, or blob sources", () => {
    for (const source of ["https://example.com/a.png", "data:image/png;base64,AA==", "blob:local"]) {
      expect(resolveVaultAsset({ vaultPath: "/vault", documentPath: "n.md", source })).toBe(source);
    }
  });
});

describe("vault link navigation", () => {
  it("normalizes a nested local link without losing its decoration", () => {
    expect(resolveVaultReference({
      documentPath: "notes/Today.md",
      source: "../attachments/Preview%20caf%C3%A9.json?raw=1#details",
    })).toEqual({
      path: "attachments/Preview café.json",
      decoration: "?raw=1#details",
    });
  });

  it("rejects above-root traversal, encoded separators, and non-file schemes", () => {
    for (const source of [
      "../../outside.json",
      "%2e%2e%2foutside.json",
      "a%5cb.json",
      "data:text/plain,hello",
      "javascript:alert(1)",
      "//example.com/file.json",
    ]) {
      expect(resolveVaultReference({ documentPath: "note.md", source })).toBeNull();
    }
  });

  it("routes local attachments inside Noam and web links to the OS", async () => {
    const openLocal = vi.fn(async () => {});
    const openExternal = vi.fn(async () => {});

    await expect(openMarkdownLink({
      documentPath: "notes/Today.md",
      source: "../attachments/Sample%20data.json#row-2",
      openLocal,
      openExternal,
    })).resolves.toBe("local");
    expect(openLocal).toHaveBeenCalledExactlyOnceWith("attachments/Sample data.json");
    expect(openExternal).not.toHaveBeenCalled();

    await expect(openMarkdownLink({
      documentPath: "notes/Today.md",
      source: "https://example.com/report.pdf",
      openLocal,
      openExternal,
    })).resolves.toBe("external");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/report.pdf");
  });

  it("does not hand unsafe or same-document destinations to either opener", async () => {
    const openLocal = vi.fn(async () => {});
    const openExternal = vi.fn(async () => {});
    for (const source of ["#section", "../../outside.json", "blob:local", "javascript:alert(1)"]) {
      await expect(openMarkdownLink({
        documentPath: "note.md",
        source,
        openLocal,
        openExternal,
      })).resolves.toBe("ignored");
    }
    expect(openLocal).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
