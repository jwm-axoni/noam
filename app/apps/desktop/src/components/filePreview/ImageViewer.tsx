import { useEffect, useState } from "react";
import { extensionOf } from "../../lib/preview";

export async function sanitizedSvgUrl(src: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error("SVG load failed");
  const text = await response.text();
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new Error("Invalid SVG");
  if (parsed.documentElement.localName !== "svg" || parsed.documentElement.namespaceURI !== "http://www.w3.org/2000/svg") throw new Error("Invalid SVG");
  parsed.querySelectorAll("script, style, foreignObject, iframe, object, embed, animate, animateMotion, animateTransform, set, use").forEach((node) => node.remove());
  parsed.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "style" ||
        name === "xml:base" ||
        ((name === "href" || name === "xlink:href" || name === "src") && !value.startsWith("#")) ||
        (/url\s*\(/i.test(value) && !/^url\(\s*['"]?#[a-zA-Z0-9_-]+['"]?\s*\)$/i.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(parsed.documentElement)], {
      type: "image/svg+xml",
    }),
  );
}

export function ImageViewer({ src, name, alt = "", compact = false }: {
  src: string;
  name: string;
  alt?: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
  const svg = extensionOf(src) === "svg";
  const safeSrc = svg ? (resolved?.source === src ? resolved.url : null) : src;

  useEffect(() => {
    setFailed(false);
    setDimensions(null);
    setFit(true);
    setZoom(1);
    if (!svg) return;
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    void sanitizedSvgUrl(src, controller.signal)
      .then((url) => {
        objectUrl = url;
        if (active) setResolved({ source: src, url });
        else URL.revokeObjectURL(url);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, svg]);

  if (failed) {
    return <div className="preview-state" role="alert"><p>Couldn't load {name}.</p></div>;
  }

  if (!safeSrc) return <div className="preview-state">Loading image…</div>;

  return (
    <div className={`image-viewer${compact ? " compact" : ""}`}>
      {!compact && (
        <div className="preview-toolbar" aria-label="Image controls">
          <button onClick={() => setFit(true)} aria-pressed={fit}>Fit</button>
          <button onClick={() => { setFit(false); setZoom((value) => Math.min(4, value + 0.25)); }} aria-label="Zoom in">+</button>
          <button onClick={() => { setFit(false); setZoom((value) => Math.max(0.25, value - 0.25)); }} aria-label="Zoom out">−</button>
          {dimensions && <span className="preview-dimensions">{dimensions}</span>}
          {alt && <span className="preview-alt">Alt: {alt}</span>}
        </div>
      )}
      <div className={`image-stage${fit ? " fit-mode" : ""}`}>
        <img
          src={safeSrc}
          alt={alt || name}
          className={fit ? "fit" : ""}
          style={fit ? undefined : { width: `${zoom * 100}%` }}
          onLoad={(event) => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
}
