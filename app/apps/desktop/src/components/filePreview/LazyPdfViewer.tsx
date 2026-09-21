import { lazy, Suspense, type ComponentProps } from "react";

const Viewer = lazy(() => import("./PdfViewer").then((module) => ({ default: module.PdfViewer })));

/** Keep PDF.js out of the editor's initial chunk and load it only for a PDF. */
export function LazyPdfViewer(props: ComponentProps<typeof Viewer>) {
  return <Suspense fallback={<div className="preview-state">Loading PDF viewer…</div>}><Viewer {...props} /></Suspense>;
}
