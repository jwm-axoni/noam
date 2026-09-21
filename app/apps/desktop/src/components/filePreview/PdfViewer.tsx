import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { readPdfText } from "./pdfText";

GlobalWorkerOptions.workerSrc = workerUrl;

const PDF_OPTIONS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  iccUrl: "/pdfjs/iccs/",
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  useWasm: true,
} as const;

type Zoom = "fit" | number;

interface PasswordRequest {
  incorrect: boolean;
  submit: (password: string) => void;
}

export function pageFromFragment(src: string): number {
  const hash = src.indexOf("#");
  if (hash < 0) return 1;
  let fragment: string;
  try { fragment = decodeURIComponent(src.slice(hash + 1)); } catch { return 1; }
  const match = /(?:^|&)page=(\d+)(?:&|$)/i.exec(fragment);
  const page = Number(match?.[1] ?? 1);
  return Number.isSafeInteger(page) ? Math.max(1, page) : 1;
}

/** Bound both backing-store allocation and the browser's canvas dimensions. */
export function rasterScale(width: number, height: number, pixelRatio: number): number {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return 0;
  return Math.min(Math.max(1, pixelRatio), 2, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
}

export function sourceWithoutFragment(src: string): string {
  const fragment = src.indexOf("#");
  return fragment >= 0 ? src.slice(0, fragment) : src;
}

function errorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "MissingPDFException") return "The PDF is missing or no longer readable.";
  if (name === "InvalidPDFException") return "This PDF is damaged or is not a valid PDF.";
  if (name === "UnexpectedResponseException") return "Noam couldn't read this PDF from disk.";
  return "Noam couldn't open this PDF.";
}

export function highlightPdfTextLayer(container: HTMLElement, query: string): void {
  const spans = Array.from(container.querySelectorAll("span"));
  for (const span of spans) span.classList.remove("pdf-search-hit");
  const term = query.toLocaleLowerCase();
  if (!term) return;

  let cursor = 0;
  const ranges = spans.map((span) => {
    const text = span.textContent ?? "";
    const range = { span, from: cursor, to: cursor + text.length };
    cursor = range.to + 1;
    return range;
  });
  const text = spans.map((span) => span.textContent ?? "").join(" ").toLocaleLowerCase();
  for (let from = text.indexOf(term); from >= 0; from = text.indexOf(term, from + term.length)) {
    const to = from + term.length;
    for (const range of ranges) {
      if (range.from < to && range.to > from) range.span.classList.add("pdf-search-hit");
    }
  }
}

function PdfPage({
  document,
  pageNumber,
  zoom,
  rotation,
  containerWidth,
  scrollRoot,
  activeSearch,
  onLayoutStart,
  onLayoutEnd,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  zoom: Zoom;
  rotation: number;
  containerWidth: number;
  scrollRoot: HTMLElement | null;
  activeSearch: string;
  onLayoutStart: () => void;
  onLayoutEnd: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(pageNumber <= 2);
  const [ratio, setRatio] = useState(1.294);
  const [failed, setFailed] = useState(false);
  const [textVersion, setTextVersion] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: scrollRoot, rootMargin: "700px 0px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible) return;
    setFailed(false);
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    let textLayer: TextLayer | null = null;
    const textAbort = new AbortController();
    // Every render owns a separate canvas. Cancelled work cannot touch the
    // canvas used by a later zoom, rotation or document switch.
    const canvas = window.document.createElement("canvas");
    const textHost = textRef.current;

    void (async () => {
      try {
        page = await document.getPage(pageNumber);
        if (cancelled || !canvasRef.current || !textRef.current) return;
        const base = page.getViewport({ scale: 1, rotation });
        const scale = zoom === "fit"
          ? Math.max(0.1, (containerWidth - 32) / base.width)
          : zoom;
        const viewport = page.getViewport({ scale, rotation });
        onLayoutStart();
        setRatio(viewport.height / viewport.width);

        const pixelRatio = rasterScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
        if (pixelRatio <= 0) throw new Error("Invalid PDF page size");
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvasRef.current.replaceChildren(canvas);
        setLayoutVersion((version) => version + 1);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas is unavailable");
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) return;

        const text = await readPdfText(page, textAbort.signal);
        if (cancelled) return;
        if (!textHost) return;
        textHost.replaceChildren();
        textLayer = new TextLayer({
          textContentSource: text,
          container: textHost,
          viewport,
        });
        await textLayer.render();
        if (!cancelled) setTextVersion((version) => version + 1);
      } catch (error) {
        if (!cancelled && (error as { name?: string }).name !== "RenderingCancelledException") {
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textAbort.abort();
      // PDF.js caches page proxies across display and search. The document owns
      // their cleanup; resetting one render must not invalidate another reader.
      onLayoutStart();
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
      textHost?.replaceChildren();
      onLayoutEnd();
    };
  }, [containerWidth, document, onLayoutEnd, onLayoutStart, pageNumber, rotation, visible, zoom]);

  useLayoutEffect(() => {
    if (layoutVersion > 0) onLayoutEnd();
  }, [layoutVersion, onLayoutEnd]);

  useEffect(() => {
    if (textRef.current) highlightPdfTextLayer(textRef.current, activeSearch);
  }, [activeSearch, textVersion]);

  const width = Math.max(220, containerWidth - 32);
  return (
    <div
      ref={hostRef}
      className="pdf-page-shell"
      data-page={pageNumber}
      style={{ minHeight: Math.round(width * ratio) }}
      aria-label={`Page ${pageNumber}`}
    >
      {visible && (
        <div className="pdf-page">
          <div ref={canvasRef} />
          <div ref={textRef} className="textLayer" />
        </div>
      )}
      {failed && <p className="pdf-page-error">Page {pageNumber} couldn't be rendered.</p>}
    </div>
  );
}

export function PdfViewer({
  src,
  name,
  compact = false,
  onOpenExternal,
}: {
  src: string;
  name: string;
  compact?: boolean;
  onOpenExternal?: () => void;
}) {
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const searchRunRef = useRef(0);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
  const [password, setPassword] = useState("");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [rotation, setRotation] = useState(0);
  const [page, setPage] = useState(pageFromFragment(src));
  const [width, setWidth] = useState(800);
  const widthRef = useRef(width);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<number[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const pageRef = useRef(page);
  const anchorRef = useRef<{ page: number; offset: number } | null>(null);

  const captureAnchor = useCallback(() => {
    if (anchorRef.current || !scrollRoot) return;
    const anchorPage = pageRef.current;
    const target = scrollRoot.querySelector<HTMLElement>(`[data-page="${anchorPage}"]`);
    if (!target) return;
    anchorRef.current = {
      page: anchorPage,
      offset: target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top,
    };
  }, [scrollRoot]);

  const restoreAnchor = useCallback(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!anchor || !scrollRoot) return;
    const target = scrollRoot.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`);
    if (!target) return;
    const offset = target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
    scrollRoot.scrollTop += offset - anchor.offset;
  }, [scrollRoot]);

  useEffect(() => {
    let active = true;
    setDocument(null);
    setError(null);
    setPasswordRequest(null);
    setPassword("");
    setMatches([]);
    setMatchIndex(0);
    setQuery("");
    setActiveQuery("");
    setSearchMessage(null);
    setSearching(false);
    setZoom("fit");
    setRotation(0);
    let task: ReturnType<typeof getDocument>;
    try {
      task = getDocument({ url: sourceWithoutFragment(src), ...PDF_OPTIONS });
    } catch (cause) {
      setError(errorMessage(cause));
      return () => { active = false; };
    }
    task.onPassword = (submit: (password: string) => void, reason: number) => {
      if (!active) return;
      setPasswordRequest({
        submit,
        incorrect: reason === PasswordResponses.INCORRECT_PASSWORD,
      });
    };
    let owned: PDFDocumentProxy | null = null;
    void task.promise
      .then((loaded) => {
        owned = loaded;
        if (!active) { void loaded.cleanup().catch(() => {}); return; }
        setPasswordRequest(null);
        setDocument(loaded);
        const initialPage = Math.min(pageFromFragment(src), loaded.numPages);
        pageRef.current = initialPage;
        setPage(initialPage);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
      searchRunRef.current += 1;
      void task.destroy().catch(() => {});
      void owned?.cleanup().catch(() => {});
    };
  }, [src]);

  useEffect(() => {
    const scroller = scrollRoot;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const initialWidth = scroller.clientWidth || 800;
    widthRef.current = initialWidth;
    setWidth(initialWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === widthRef.current) return;
      captureAnchor();
      widthRef.current = entry.contentRect.width;
      setWidth(entry.contentRect.width);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [captureAnchor, scrollRoot]);

  useLayoutEffect(() => {
    restoreAnchor();
  }, [restoreAnchor, rotation, width, zoom]);

  const pages = useMemo(
    () => Array.from({ length: document?.numPages ?? 0 }, (_, index) => index + 1),
    [document?.numPages],
  );

  const goToPage = useCallback((next: number) => {
    if (!document || !Number.isFinite(next)) return;
    const bounded = Math.max(1, Math.min(document.numPages, Math.floor(next)));
    anchorRef.current = null;
    pageRef.current = bounded;
    setPage(bounded);
    const target = scrollRoot?.querySelector<HTMLElement>(`[data-page="${bounded}"]`);
    if (target && scrollRoot) {
      scrollRoot.scrollTop += target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
    }
  }, [document, scrollRoot]);

  useEffect(() => {
    if (document && scrollRoot) goToPage(pageFromFragment(src));
  }, [document, scrollRoot, src, goToPage]);

  const runSearch = async () => {
    const term = query.trim().toLocaleLowerCase();
    if (!document || !term) return;
    setActiveQuery(term);
    setSearching(true);
    const searchRun = ++searchRunRef.current;
    setSearchMessage(null);
    const found: number[] = [];
    let textItems = 0;
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (searchRun !== searchRunRef.current) return;
        const pdfPage = await document.getPage(pageNumber);
        const content = await readPdfText(pdfPage);
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        textItems += text.trim().length;
        if (text.toLocaleLowerCase().includes(term)) found.push(pageNumber);
      }
      if (searchRun !== searchRunRef.current) return;
      setMatches(found);
      setMatchIndex(0);
      if (found.length > 0) goToPage(found[0]);
      else setSearchMessage(textItems === 0 ? "This PDF has no searchable text." : "No matches.");
    } catch {
      if (searchRun === searchRunRef.current) setSearchMessage("Search failed. The PDF is still available to read.");
    } finally {
      if (searchRun === searchRunRef.current) setSearching(false);
    }
  };

  if (error) {
    return (
      <div className="preview-state" role="alert">
        <p>{error}</p>
        {onOpenExternal && <button onClick={onOpenExternal}>Open externally</button>}
      </div>
    );
  }

  if (passwordRequest) {
    return (
      <form
        className="preview-state"
        onSubmit={(event) => {
          event.preventDefault();
          passwordRequest.submit(password);
          setPassword("");
        }}
      >
        <p>{passwordRequest.incorrect ? "That password didn't work." : "This PDF needs a password."}</p>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-label="PDF password"
          autoFocus
        />
        <button type="submit" disabled={!password}>Unlock</button>
      </form>
    );
  }

  if (!document) return <div className="preview-state"><p>Loading {name}…</p></div>;

  return (
    <div className={`pdf-viewer${compact ? " compact" : ""}`}>
      <div className="preview-toolbar" aria-label="PDF controls">
        <button onClick={() => goToPage(page - 1)} disabled={page <= 1} aria-label="Previous page">‹</button>
        <label className="pdf-page-control">
          <span className="sr-only">Page</span>
          <input
            type="number"
            min={1}
            max={document.numPages}
            value={page}
            onChange={(event) => goToPage(Number(event.target.value))}
          />
          <span>of {document.numPages}</span>
        </label>
        <button onClick={() => goToPage(page + 1)} disabled={page >= document.numPages} aria-label="Next page">›</button>
        <button onClick={() => { captureAnchor(); setZoom("fit"); }} aria-pressed={zoom === "fit"}>Fit</button>
        <button onClick={() => { captureAnchor(); setZoom((value) => value === "fit" ? 1.1 : Math.min(3, value + 0.2)); }} aria-label="Zoom in">+</button>
        <button onClick={() => { captureAnchor(); setZoom((value) => value === "fit" ? 0.8 : Math.max(0.3, value - 0.2)); }} aria-label="Zoom out">−</button>
        <button onClick={() => { captureAnchor(); setRotation((value) => (value + 90) % 360); }}>Rotate</button>
        <form
            className="pdf-search"
            onSubmit={(event) => { event.preventDefault(); void runSearch(); }}
          >
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search PDF" aria-label="Search PDF" />
            <button type="submit" disabled={searching || !query.trim()}>{searching ? "Searching…" : "Find"}</button>
            {matches.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const next = (matchIndex + 1) % matches.length;
                  setMatchIndex(next);
                  goToPage(matches[next]);
                }}
              >
                {matchIndex + 1} of {matches.length}
              </button>
            )}
        </form>
        {onOpenExternal && <button onClick={onOpenExternal}>Open externally</button>}
      </div>
      {searchMessage && <div className="pdf-search-message" role="status">{searchMessage}</div>}
      <div ref={setScrollRoot} className="pdf-pages" onScroll={(event) => {
        const root = event.currentTarget;
        const top = root.getBoundingClientRect().top;
        const candidates = Array.from(root.querySelectorAll<HTMLElement>("[data-page]"));
        const current = candidates.find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.top + bounds.height / 2 >= top;
        });
        if (current) {
          const currentPage = Number(current.dataset.page);
          pageRef.current = currentPage;
          setPage(currentPage);
        }
      }}>
        {pages.map((pageNumber) => (
          <PdfPage
            key={pageNumber}
            document={document}
            pageNumber={pageNumber}
            zoom={zoom}
            rotation={rotation}
            containerWidth={width}
            scrollRoot={scrollRoot}
            activeSearch={activeQuery}
            onLayoutStart={captureAnchor}
            onLayoutEnd={restoreAnchor}
          />
        ))}
      </div>
    </div>
  );
}
