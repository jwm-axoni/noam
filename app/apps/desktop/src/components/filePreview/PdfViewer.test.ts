// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfViewer, rasterScale } from "./PdfViewer";

const pdf = vi.hoisted(() => ({
  getDocument: vi.fn(),
  render: vi.fn(),
  cancel: vi.fn(),
  layers: vi.fn(),
  layerItems: ["quiet garden"],
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdf.getDocument,
  GlobalWorkerOptions: {},
  PasswordResponses: { INCORRECT_PASSWORD: 2 },
  TextLayer: class {
    container: HTMLElement;
    constructor({ container }: { container: HTMLElement }) { this.container = container; }
    async render() {
      this.container.replaceChildren(
        ...pdf.layerItems.map((text) => Object.assign(document.createElement("span"), { textContent: text })),
      );
      pdf.layers();
    }
    cancel() {}
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function documentFixture(items = ["quiet garden"]) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: pdf.render,
    getTextContent: vi.fn(async () => ({ items: items.map((str) => ({ str })) })),
    streamTextContent: vi.fn(() => new ReadableStream({ start(controller) {
      controller.enqueue({ items: items.map((str) => ({ str })), styles: {}, lang: "en" }); controller.close();
    } })),
    cleanup: vi.fn(),
  };
  return { numPages: 4, getPage: vi.fn(async () => page), cleanup: vi.fn(async () => {}), page };
}

function loadingTask() {
  return { ...deferred<ReturnType<typeof documentFixture>>(), destroy: vi.fn(async () => {}), onPassword: null as null | ((submit: (password: string) => void, reason: number) => void) };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("PDF viewer lifecycle", () => {
  let root: Root;
  let host: HTMLDivElement;
  let observed: HTMLElement[];
  let resize: ResizeObserverCallback;
  beforeEach(() => {
    vi.clearAllMocks();
    pdf.layerItems = ["quiet garden"];
    observed = [];
    vi.stubGlobal("ResizeObserver", class { constructor(public callback: ResizeObserverCallback) { resize = callback; } observe(target: HTMLElement) { observed.push(target); this.callback([{ contentRect: { width: 480 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} });
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { top: Number(this.dataset.page ?? 0) * 500, height: 500, width: 480, left: 0, right: 480, bottom: 500, x: 0, y: 0, toJSON() {} };
    });
    pdf.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel: pdf.cancel }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function render(src: string) { await act(async () => root.render(createElement(PdfViewer, { src, name: "Fixture" }))); }

  it("measures the mounted pane and navigates to a linked page after loading", async () => {
    const task = loadingTask();
    const doc = documentFixture();
    pdf.getDocument.mockReturnValue(task);
    await render("asset:/fixture.pdf#page=3");
    expect(observed).toHaveLength(0);
    await act(async () => task.resolve(doc));
    expect(observed.some((element) => element.className === "pdf-pages")).toBe(true);
    expect(host.querySelector<HTMLDivElement>(".pdf-pages")?.scrollTop).toBe(1500);
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("3");
    expect(host.querySelector(".textLayer span")?.textContent).toBe("quiet garden");
    expect(pdf.getDocument.mock.calls[0][0].url).toBe("asset:/fixture.pdf");
  });

  it("discards stale password and load callbacks when the file changes", async () => {
    const first = loadingTask();
    const second = loadingTask();
    pdf.getDocument.mockReturnValueOnce(first).mockReturnValueOnce(second);
    await render("asset:/first.pdf");
    await act(async () => first.onPassword?.(vi.fn(), 1));
    expect(host.textContent).toContain("needs a password");
    await render("asset:/second.pdf");
    expect(first.destroy).toHaveBeenCalledOnce();
    await act(async () => first.onPassword?.(vi.fn(), 2));
    expect(host.textContent).not.toContain("password");
    const stale = documentFixture();
    await act(async () => { first.resolve(stale); second.resolve(documentFixture()); });
    expect(stale.cleanup).toHaveBeenCalled();
    expect(host.querySelector(".pdf-viewer")).not.toBeNull();
  });

  it("shows password retry state and removes the prompt after unlocking", async () => {
    const task = loadingTask();
    pdf.getDocument.mockReturnValue(task);
    await render("asset:/protected.pdf");
    await act(async () => task.onPassword?.(vi.fn(), 2));
    expect(host.textContent).toContain("That password didn't work");
    await act(async () => task.resolve(documentFixture()));
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.querySelector(".pdf-viewer")).not.toBeNull();
  });

  it("destroys loading resources and cancels pending page work on unmount", async () => {
    const task = loadingTask();
    const pendingRender = deferred<void>();
    pdf.render.mockReturnValue({ promise: pendingRender.promise, cancel: pdf.cancel });
    pdf.getDocument.mockReturnValue(task);
    await render("asset:/fixture.pdf");
    const doc = documentFixture();
    await act(async () => task.resolve(doc));
    await act(async () => root.render(null));
    expect(task.destroy).toHaveBeenCalled();
    expect(pdf.cancel).toHaveBeenCalled();
    expect(doc.cleanup).toHaveBeenCalled();
    await act(async () => pendingRender.resolve());
    expect(pdf.layers).not.toHaveBeenCalled();
  });

  it("shows a recoverable corrupt-file error", async () => {
    const task = loadingTask();
    pdf.getDocument.mockReturnValue(task);
    await render("asset:/broken.pdf");
    const error = new Error("bad"); error.name = "InvalidPDFException";
    await act(async () => task.reject(error));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("damaged");
  });

  it("shows a recoverable error when PDF.js throws before returning a loading task", async () => {
    const error = new Error("bad"); error.name = "InvalidPDFException";
    pdf.getDocument.mockImplementation(() => { throw error; });
    await render("asset:/broken.pdf");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("damaged");
  });

  it("searches cached pages without cancelling the display or cleaning shared proxies", async () => {
    const task = loadingTask();
    const doc = documentFixture();
    pdf.getDocument.mockReturnValue(task);
    await render("asset:/fixture.pdf");
    await act(async () => task.resolve(doc));
    const canvas = host.querySelector("canvas");
    const renders = pdf.render.mock.calls.length;
    const input = host.querySelector<HTMLInputElement>('[aria-label="Search PDF"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "quiet garden");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain("1 of 4");
    expect(host.querySelector("canvas")).toBe(canvas);
    expect(pdf.render).toHaveBeenCalledTimes(renders);
    expect(doc.page.cleanup).not.toHaveBeenCalled();
    expect(host.querySelector(".pdf-search-hit")).not.toBeNull();
  });

  it("highlights a search match split across adjacent text spans", async () => {
    pdf.layerItems = ["quiet", "garden"];
    const task = loadingTask();
    pdf.getDocument.mockReturnValue(task);
    await render("asset:/fixture.pdf");
    await act(async () => task.resolve(documentFixture(["quiet", "garden"])));
    const input = host.querySelector<HTMLInputElement>('[aria-label="Search PDF"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "quiet garden");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.querySelector(".textLayer")?.querySelectorAll(".pdf-search-hit")).toHaveLength(2);
  });

  it("keeps the selected page anchored through delayed dimensions, rotation, zoom, fit, and resize", async () => {
    const task = loadingTask();
    const delayedFirst = deferred<ReturnType<typeof pageFixture>>();
    const sizes = [
      { width: 400, height: 900 },
      { width: 700, height: 500 },
      { width: 500, height: 1_200 },
      { width: 800, height: 600 },
    ];
    function pageFixture(pageNumber: number) {
      const size = sizes[pageNumber - 1];
      return {
        getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) => {
          const sideways = Math.abs(rotation % 180) === 90;
          return {
            width: (sideways ? size.height : size.width) * scale,
            height: (sideways ? size.width : size.height) * scale,
          };
        },
        render: pdf.render,
        streamTextContent: vi.fn(() => new ReadableStream({ start(controller) {
          controller.enqueue({ items: [{ str: "quiet garden" }], styles: {}, lang: "en" }); controller.close();
        } })),
        cleanup: vi.fn(),
      };
    }
    const pageFixtures = sizes.map((_, index) => pageFixture(index + 1));
    const doc = {
      numPages: 4,
      getPage: vi.fn((pageNumber: number) => pageNumber === 1
        ? delayedFirst.promise
        : Promise.resolve(pageFixtures[pageNumber - 1])),
      cleanup: vi.fn(async () => {}),
    };
    pdf.getDocument.mockReturnValue(task);

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const scroller = host.querySelector<HTMLElement>(".pdf-pages");
      if (this === scroller) return rect(100, 600);
      if (this.dataset.page && scroller) {
        const shells = Array.from(scroller.querySelectorAll<HTMLElement>("[data-page]"));
        const index = shells.indexOf(this);
        const heights = shells.map((shell) => Math.max(
          Number.parseFloat(shell.style.minHeight) || 0,
          Number.parseFloat(shell.querySelector<HTMLCanvasElement>("canvas")?.style.height ?? "0") || 0,
        ));
        const top = 100 - scroller.scrollTop
          + heights.slice(0, index).reduce((total, height) => total + height + 16, 0);
        return rect(top, heights[index]);
      }
      return rect(0, 0);
    });

    await render("asset:/fixture.pdf");
    await act(async () => task.resolve(doc as ReturnType<typeof documentFixture>));
    const scroller = host.querySelector<HTMLElement>(".pdf-pages")!;
    const pageTwo = () => host.querySelector<HTMLElement>('[data-page="2"]')!;
    const offset = () => pageTwo().getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const pageInput = host.querySelector<HTMLInputElement>('input[type="number"]')!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pageInput, "2");
      pageInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(offset()).toBeCloseTo(0, 5);

    const pageThree = host.querySelector<HTMLElement>('[data-page="3"]')!;
    scroller.scrollTop += pageThree.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    await act(async () => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(pageInput.value).toBe("3");

    await act(async () => delayedFirst.resolve(pageFixtures[0]));
    expect(pageThree.getBoundingClientRect().top - scroller.getBoundingClientRect().top).toBeCloseTo(0, 5);
    expect(pageInput.value).toBe("3");

    const search = host.querySelector<HTMLInputElement>('[aria-label="Search PDF"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "quiet garden");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => search.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => host.querySelector<HTMLButtonElement>(".pdf-search button[type=button]")!.click());
    expect(pageInput.value).toBe("2");
    expect(offset()).toBeCloseTo(0, 5);

    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Rotate")!.click());
    expect(offset()).toBeCloseTo(0, 5);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(offset()).toBeCloseTo(0, 5);
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Fit")!.click());
    expect(offset()).toBeCloseTo(0, 5);
    await act(async () => resize([{ contentRect: { width: 360 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(offset()).toBeCloseTo(0, 5);
    expect(pageInput.value).toBe("2");
  });

  it("caps allocation for extreme page dimensions", () => {
    const width = 200_000, height = 400_000;
    const scale = rasterScale(width, height, 3);
    expect(Math.floor(width * scale) * Math.floor(height * scale)).toBeLessThanOrEqual(16_000_000);
    expect(Math.max(width, height) * scale).toBeLessThanOrEqual(8192);
    expect(rasterScale(Infinity, height, 2)).toBe(0);
  });
});

function rect(top: number, height: number): DOMRect {
  return { top, height, width: 480, left: 0, right: 480, bottom: top + height, x: 0, y: top, toJSON() {} };
}
