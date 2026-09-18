import { useEffect, useRef, type ReactNode } from "react";
import { WORKSPACE_RESIZE_EVENT } from "../../layout/types";

/** The sole live editor host. It remains mounted when a future center tool covers it. */
export function DocumentHost({
  hidden = false,
  children,
}: {
  hidden?: boolean;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    const notify = () => {
      if (frame != null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        window.dispatchEvent(new Event(WORKSPACE_RESIZE_EVENT));
      });
    };
    const observer = new ResizeObserver(notify);
    observer.observe(host);
    const onTransitionEnd: EventListener = (event) => {
      if (event instanceof TransitionEvent && event.propertyName === "grid-template-columns") notify();
    };
    host.closest(".workspace-shell")?.addEventListener("transitionend", onTransitionEnd);
    void document.fonts?.ready.then(notify);
    return () => {
      observer.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
      host.closest(".workspace-shell")?.removeEventListener("transitionend", onTransitionEnd);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="workspace-document-host"
      style={hidden ? { display: "none" } : undefined}
      inert={hidden ? true : undefined}
      aria-hidden={hidden || undefined}
    >
      {children}
    </div>
  );
}
