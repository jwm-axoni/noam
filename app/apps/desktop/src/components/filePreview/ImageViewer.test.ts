// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageViewer, sanitizedSvgUrl } from "./ImageViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("safe image previews", () => {
  let host: HTMLDivElement;
  let root: Root;
  let blobs: Blob[];
  const fetchMock = vi.fn();
  const revoke = vi.fn();
  beforeEach(() => {
    blobs = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL: (blob: Blob) => { blobs.push(blob); return `blob:safe-${blobs.length}`; }, revokeObjectURL: revoke });
    fetchMock.mockReset(); revoke.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const render = (src: string) => act(async () => root.render(createElement(ImageViewer, { src, name: "Fixture" })));
  const svgResponse = (text: string) => ({ ok: true, text: async () => text });
  const blobText = (blob: Blob) => new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });

  it("removes active content and external SVG references before creating a URL", async () => {
    fetchMock.mockResolvedValue(svgResponse(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject>unsafe</foreignObject><style>@import url(//host)</style><image href="//host/a"/><image href="file:///secret"/><use href="#id"/><rect style="fill:url(//host)" fill="url(//host)"/><path fill="url(#gradient)"/><linearGradient id="gradient"/></svg>`));
    await sanitizedSvgUrl("asset:/fixture.svg");
    const markup = await blobText(blobs[0]);
    expect(markup).not.toMatch(/script|foreignObject|style|onload|href|\/\/host|file:/);
    expect(markup).toContain('fill="url(#gradient)"');
  });

  it("never loads the original SVG before sanitization", async () => {
    let finish!: (response: ReturnType<typeof svgResponse>) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render("asset:/fixture.svg");
    expect(host.querySelector("img")).toBeNull();
    await act(async () => finish(svgResponse('<svg xmlns="http://www.w3.org/2000/svg"/>')));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:safe-1");
  });

  it("removes external XML bases before allowing same-document references", async () => {
    fetchMock.mockResolvedValue(svgResponse('<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://attacker.test/"><image href="#pixel"/></svg>'));
    await sanitizedSvgUrl("asset:/fixture.svg");
    expect(await blobText(blobs[0])).not.toMatch(/xml:base|attacker/);
  });

  it("aborts and revokes a late SVG result after switching files", async () => {
    let finish!: (response: ReturnType<typeof svgResponse>) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render("asset:/fixture.svg");
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await render("asset:/new.png");
    expect(signal.aborted).toBe(true);
    await act(async () => finish(svgResponse('<svg xmlns="http://www.w3.org/2000/svg"/>')));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("asset:/new.png");
    expect(revoke).toHaveBeenCalledWith("blob:safe-1");
  });

  it("rejects malformed SVG and resets the error for the next image", async () => {
    fetchMock.mockResolvedValue(svgResponse("<svg><not-closed>"));
    await render("asset:/bad.svg");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await render("asset:/new.png");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("asset:/new.png");
  });
});
