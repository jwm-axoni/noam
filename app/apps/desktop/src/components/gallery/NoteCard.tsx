// The note card face shared by the folder gallery and dashboard card views:
// a thumbnail (first image, else the excerpt, else a placeholder) above the
// filename stem and the modified date.
//
// Everything it shows came from the index (the excerpt and first image were
// derived when the note was indexed); nothing renders markdown here, and every
// value is a React text node. Thumbnails decode only once the card nears the
// viewport of the scroller that provides `NearViewport`.

import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { resolveVaultAsset } from "../../lib/fileTypes/assetResolver";
import { fullDate, relativeDate } from "../../lib/gallery/cards";

/** Start loading a thumbnail this far before it scrolls into view. */
const THUMB_ROOT_MARGIN = "400px 0px";

export type Observe = (el: Element, onNear: () => void) => () => void;

/** The scroller's "tell me when this element is near" hook. */
export const NearViewport = createContext<Observe | null>(null);

/** What a card face needs; a folder gallery note and a dashboard row both fit. */
export interface NoteCardData {
  name: string;
  excerpt: string | null;
  firstImage: string | null;
  /** Epoch ms; 0 or null when unknown (no date line). */
  modified: number | null;
  /** 0-byte file: a server-only note that has not been downloaded yet. */
  empty: boolean;
}

/**
 * One IntersectionObserver per scroller, so hundreds of cards only decode the
 * thumbnails near the viewport. Without IntersectionObserver (tests) every
 * card counts as near.
 */
export function useNearViewportObserver(scroller: RefObject<HTMLElement | null>): Observe | null {
  const [observe, setObserve] = useState<Observe | null>(null);
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      setObserve(() => (_el: Element, onNear: () => void) => {
        onNear();
        return () => {};
      });
      return;
    }
    const waiting = new Map<Element, () => void>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          waiting.get(entry.target)?.();
          waiting.delete(entry.target);
          io.unobserve(entry.target);
        }
      },
      { root, rootMargin: THUMB_ROOT_MARGIN },
    );
    setObserve(() => (el: Element, onNear: () => void) => {
      waiting.set(el, onNear);
      io.observe(el);
      return () => {
        waiting.delete(el);
        io.unobserve(el);
      };
    });
    return () => io.disconnect();
  }, [scroller]);
  return observe;
}

export function NoteCardFace({ card, vaultPath }: { card: NoteCardData; vaultPath: string | null }) {
  const observe = useContext(NearViewport);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const [near, setNear] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!card.firstImage || near) return;
    const el = thumbRef.current;
    if (!el || !observe) return;
    return observe(el, () => setNear(true));
  }, [card.firstImage, near, observe]);
  useEffect(() => setBroken(false), [card.firstImage]);

  const src = card.firstImage && near && !broken && vaultPath
    ? resolveVaultAsset({ vaultPath, documentPath: "", source: card.firstImage, sourceKind: "path" })
    : null;
  const now = Date.now();
  const modified = card.modified ?? 0;

  let thumb;
  if (card.empty) {
    thumb = <span className="gallery-placeholder">Not downloaded yet</span>;
  } else if (card.firstImage && !broken) {
    // Blank until the card nears the viewport; a failed load falls back to text.
    thumb = src
      ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
      : null;
  } else if (card.excerpt) {
    thumb = <span className="gallery-excerpt">{card.excerpt}</span>;
  } else {
    thumb = <span className="gallery-placeholder">Empty note</span>;
  }

  return (
    <>
      <span className="gallery-thumb" ref={thumbRef}>{thumb}</span>
      <span className="gallery-card-meta">
        <span className="gallery-card-title">{card.name}</span>
        {modified > 0 && (
          <span className="gallery-card-sub" title={fullDate(modified)}>
            {relativeDate(modified, now)}
          </span>
        )}
      </span>
    </>
  );
}
