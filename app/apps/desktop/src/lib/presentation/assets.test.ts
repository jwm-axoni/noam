// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAttachment } from "../attachments";
import {
  MAX_ICON_BYTES,
  __presentationAssetTest,
  savePresentationAsset,
  validatePresentationAsset,
} from "./assets";

vi.mock("../attachments", () => ({ saveAttachment: vi.fn() }));

const bytes = (source: string) => new TextEncoder().encode(source);
const target = { vaultEpoch: 7, vaultScope: "/vaults/test", isCurrent: () => true };
const fixture = {
  png: Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8E8WQAAAABJRU5ErkJggg=="),
    (character) => character.charCodeAt(0),
  ),
  jpeg: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0),
  webp: bytes("RIFF\0\0\0\0WEBP"),
  svg: bytes(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path id="leaf" d="M0 0h1v1z"/><use href="#leaf"/></svg>',
  ),
};

describe("presentation asset import", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports unsupported and oversized files", () => {
    expect(validatePresentationAsset("icon.gif", Uint8Array.of(1), "icon")).toMatchObject({ ok: false });
    expect(validatePresentationAsset("icon.png", new Uint8Array(MAX_ICON_BYTES + 1), "icon")).toEqual({
      ok: false,
      message: "Icons must be 5 MB or smaller.",
    });
  });

  it("accepts valid format fixtures and rejects mislabeled bytes", () => {
    expect(validatePresentationAsset("pixel.png", fixture.png, "icon")).toMatchObject({ ok: true });
    expect(validatePresentationAsset("photo.jpg", fixture.jpeg, "icon")).toMatchObject({ ok: true });
    expect(validatePresentationAsset("image.webp", fixture.webp, "cover")).toMatchObject({ ok: true });
    expect(validatePresentationAsset("shape.svg", fixture.svg, "icon")).toMatchObject({ ok: true });

    expect(validatePresentationAsset("shape.png", fixture.svg, "icon")).toEqual({
      ok: false,
      message: "The file contents do not match the .png extension.",
    });
    expect(validatePresentationAsset("pixel.svg", fixture.png, "icon")).toMatchObject({ ok: false });
  });

  it("rejects mislabeled cover bytes before writing an original", async () => {
    vi.mocked(saveAttachment).mockClear();
    await expect(
      savePresentationAsset("looks-like-a-photo.png", fixture.svg, "cover", target),
    ).resolves.toEqual({
      error: "The file contents do not match the .png extension.",
    });
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  it("pins attachment writes to the originating vault epoch", async () => {
    class LoadedImage {
      naturalWidth = 1;
      naturalHeight = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([fixture.png], { type: "image/png" }));
    });
    vi.mocked(saveAttachment).mockResolvedValue("/attachments/icon.png");

    await expect(
      savePresentationAsset("icon.png", fixture.png, "icon", {
        vaultEpoch: 41,
        vaultScope: "/vaults/test",
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ path: "attachments/icon.png" });
    expect(saveAttachment).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "png",
      41,
    );
  });

  it("stores a metadata-free retained cover source beside its bounded preview", async () => {
    vi.mocked(saveAttachment).mockClear();
    class LoadedImage {
      naturalWidth = 2400;
      naturalHeight = 1600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", LoadedImage);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(), drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const sourceBytes = Uint8Array.of(0xff, 0xd8, 0xff, 0x11);
    const previewBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
    let render = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, mime) => {
      const value = render++ === 0 ? sourceBytes : previewBytes;
      callback(new Blob([value], { type: mime ?? "image/png" }));
    });
    vi.mocked(saveAttachment)
      .mockResolvedValueOnce("/attachments/noam/covers/source.jpg")
      .mockResolvedValueOnce("/attachments/noam/covers/preview.png");

    await expect(savePresentationAsset("camera.jpg", fixture.jpeg, "cover", target)).resolves.toEqual({
      path: "attachments/noam/covers/preview.png",
      sourcePath: "attachments/noam/covers/source.jpg",
    });
    expect(saveAttachment).toHaveBeenNthCalledWith(1, sourceBytes, "jpg", 7);
    expect(saveAttachment).toHaveBeenNthCalledWith(2, previewBytes, "png", 7);
    expect(saveAttachment).not.toHaveBeenCalledWith(fixture.jpeg, expect.anything(), expect.anything());
  });

  it("removes the SVG attack surface by refusing active and external content", () => {
    expect(() =>
      __presentationAssetTest.sanitizedSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
    ).toThrow("active content");
    expect(() =>
      __presentationAssetTest.sanitizedSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>')),
    ).toThrow("external resource");
    expect(() =>
      __presentationAssetTest.sanitizedSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(relative.svg#paint)"/></svg>')),
    ).toThrow("external resource");
    expect(
      __presentationAssetTest.sanitizedSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"><use href="#leaf"/></svg>')),
    ).toContain('href="#leaf"');
    expect(
      __presentationAssetTest.sanitizedSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="paint"/><path fill="url(#paint)"/></svg>')),
    ).toContain("url(#paint)");
  });

  it("rejects SVG namespace confusion and fragment references under xml:base", () => {
    expect(() =>
      __presentationAssetTest.sanitizedSvg(
        bytes('<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://example.com/asset.svg"><use href="#leaf"/></svg>'),
      ),
    ).toThrow("XML base URL");
    expect(() =>
      __presentationAssetTest.sanitizedSvg(
        bytes('<svg xmlns="http://www.w3.org/2000/svg"><g xml:base="https://example.com/"><use href="#leaf"/></g></svg>'),
      ),
    ).toThrow("XML base URL");
    expect(() =>
      __presentationAssetTest.sanitizedSvg(
        bytes('<svg xmlns="https://example.com/not-svg"><use href="#leaf"/></svg>'),
      ),
    ).toThrow("could not be read");
    expect(() =>
      __presentationAssetTest.sanitizedSvg(
        bytes('<svg xmlns="http://www.w3.org/2000/svg"><x:use xmlns:x="https://example.com/ns" href="#leaf"/></svg>'),
      ),
    ).toThrow("outside the SVG namespace");
  });

  it("plans a bounded square crop from the selected focal point and zoom", () => {
    expect(__presentationAssetTest.planRasterCrop(400, 200, 256, 256)).toEqual({
      x: -128,
      y: 0,
      width: 512,
      height: 256,
    });
    expect(
      __presentationAssetTest.planRasterCrop(400, 200, 256, 256, {
        x: 100,
        y: -20,
        zoom: 4,
      }),
    ).toEqual({
      x: -1280,
      y: 0,
      width: 1536,
      height: 768,
    });
  });
});
