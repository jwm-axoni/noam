import { describe, expect, it } from "vitest";
import { canEmbed, extensionOf, fileType, previewKind } from "./preview";

describe("file type registry", () => {
  it("classifies decorated, mixed-case, and Unicode paths", () => {
    expect(extensionOf("资料/Annual Report.PDF?page=3#selection")).toBe("pdf");
    expect(previewKind("资料/Annual Report.PDF?page=3#selection")).toBe("pdf");
    expect(previewKind("photo.AVIF#crop")).toBe("image");
  });

  it("uses MIME when a file name has no useful extension", () => {
    expect(fileType("download", "application/pdf; charset=binary")?.id).toBe("pdf");
  });

  it("does not route notes through the binary preview pipeline", () => {
    expect(previewKind("notes/plan.md")).toBeNull();
    expect(canEmbed("notes/plan.md")).toBe(false);
  });

  it("gives unsupported office files an explicit external viewer", () => {
    expect(previewKind("brief.docx")).toBe("external");
    expect(canEmbed("brief.docx")).toBe(false);
  });
});
