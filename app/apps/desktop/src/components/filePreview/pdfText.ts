import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/** PDF.js 6 uses async stream iteration, absent in some supported WKWebViews. */
export async function readPdfText(page: PDFPageProxy, signal?: AbortSignal) {
  const reader = page.streamTextContent().getReader();
  const content: Awaited<ReturnType<PDFPageProxy["getTextContent"]>> = {
    items: [], styles: Object.create(null), lang: null,
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("PDF text read cancelled", "AbortError");
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException("PDF text read cancelled", "AbortError");
      if (done) return content;
      content.lang ??= value.lang;
      content.items.push(...value.items);
      Object.assign(content.styles, value.styles);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
