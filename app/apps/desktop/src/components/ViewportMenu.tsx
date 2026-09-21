import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { placeMenu, type Placement } from "../lib/menuPlacement";

type MenuPoint = { x: number; y: number };

/**
 * Portal shell for menus that must escape dock overflow and stay in the window.
 * The owning component keeps control of open state, dismissal, and focus.
 */
export function ViewportMenu({
  as = "div",
  anchorRef,
  anchorPoint,
  menuRef,
  align = "end",
  side = "down",
  offset = 6,
  children,
  style,
  ...attributes
}: Omit<HTMLAttributes<HTMLElement>, "children"> & {
  as?: "div" | "ul";
  anchorRef?: RefObject<HTMLElement | null>;
  anchorPoint?: MenuPoint;
  menuRef: RefObject<HTMLElement | null>;
  align?: "start" | "end";
  side?: "down" | "up";
  offset?: number;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<Placement | null>(null);
  const pointX = anchorPoint?.x;
  const pointY = anchorPoint?.y;
  const placedStyle = position
    ? ({
        ...style,
        position: "fixed",
        left: position.left,
        top: position.top,
        right: "auto",
        bottom: "auto",
        "--viewport-menu-max-height": `${position.maxHeight}px`,
      } satisfies CSSProperties & { "--viewport-menu-max-height": string })
    : ({
        ...style,
        position: "fixed",
        left: 0,
        top: 0,
        right: "auto",
        bottom: "auto",
        visibility: "hidden",
      } satisfies CSSProperties);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const measure = () => {
      const size = { width: menu.offsetWidth, height: menu.offsetHeight };
      const elementAnchor = anchorRef?.current?.getBoundingClientRect();
      const x = elementAnchor
        ? align === "start"
          ? elementAnchor.left
          : elementAnchor.right - size.width
        : pointX ?? 0;
      const y = elementAnchor ? elementAnchor.bottom + offset : pointY ?? 0;
      const flipY = elementAnchor ? elementAnchor.top - offset : pointY;
      const next = placeMenu(
        { x, y, flipY, preferY: side },
        size,
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition((current) =>
        current &&
        current.left === next.left &&
        current.top === next.top &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(menu);
    if (anchorRef?.current) observer?.observe(anchorRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [align, anchorRef, menuRef, offset, pointX, pointY, side]);

  return createPortal(
    as === "ul" ? (
      <ul
        {...(attributes as HTMLAttributes<HTMLUListElement>)}
        ref={menuRef as RefObject<HTMLUListElement | null>}
        style={placedStyle}
      >
        {children}
      </ul>
    ) : (
      <div
        {...(attributes as HTMLAttributes<HTMLDivElement>)}
        ref={menuRef as RefObject<HTMLDivElement | null>}
        style={placedStyle}
      >
        {children}
      </div>
    ),
    document.body,
  );
}
