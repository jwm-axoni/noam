import { useEffect, useRef } from "react";
import { useLayoutStore } from "../../layout/store";

interface PaneSeparatorProps {
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  label: string;
  /** Right/bottom panes grow in the opposite pointer direction. */
  direction?: 1 | -1;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
  onCancel?: () => void;
  className?: string;
}

interface DragSession {
  pointerId: number;
  startCoordinate: number;
  startValue: number;
  previewValue: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(max, Math.max(min, value)));

export function PaneSeparator({
  orientation,
  value,
  min,
  max,
  defaultValue,
  label,
  direction = 1,
  onPreview,
  onCommit,
  onCancel,
  className = "",
}: PaneSeparatorProps) {
  const interactionGeneration = useLayoutStore((state) => state.interactionGeneration);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const frameRef = useRef<number | null>(null);
  const propsRef = useRef({ value, min, max, onPreview, onCommit, onCancel });
  propsRef.current = { value, min, max, onPreview, onCommit, onCancel };

  const flushPreview = () => {
    frameRef.current = null;
    const drag = dragRef.current;
    if (drag) {
      elementRef.current?.setAttribute("aria-valuenow", String(drag.previewValue));
      propsRef.current.onPreview(drag.previewValue);
    }
  };

  const stop = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    dragRef.current = null;
    elementRef.current?.classList.remove("is-dragging");
    document.body.removeAttribute("data-pane-resizing");
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", onWindowKeyDown);
    if (commit) {
      propsRef.current.onPreview(drag.previewValue);
      propsRef.current.onCommit(drag.previewValue);
    } else {
      elementRef.current?.setAttribute("aria-valuenow", String(drag.startValue));
      propsRef.current.onPreview(drag.startValue);
      propsRef.current.onCancel?.();
    }
  };

  const cancel = () => stop(false);
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  useEffect(() => () => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    if (dragRef.current) {
      propsRef.current.onPreview(dragRef.current.startValue);
      propsRef.current.onCancel?.();
    }
    document.body.removeAttribute("data-pane-resizing");
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", onWindowKeyDown);
  }, []);

  useEffect(() => {
    if (dragRef.current) cancel();
  }, [interactionGeneration]);

  const coordinate = (event: React.PointerEvent) =>
    orientation === "vertical" ? event.clientX : event.clientY;

  const previewKeyboardValue = (next: number) => {
    const actual = clamp(next, min, max);
    onPreview(actual);
    onCommit(actual);
  };

  return (
    <div
      ref={elementRef}
      className={`pane-separator pane-separator-${orientation} ${className}`.trim()}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title="Drag to resize · Home to reset"
      onPointerDown={(event) => {
        if (event.button !== 0 || max < min) return;
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          startCoordinate: coordinate(event),
          startValue: value,
          previewValue: value,
        };
        event.currentTarget.classList.add("is-dragging");
        document.body.setAttribute("data-pane-resizing", orientation);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", onWindowKeyDown);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.previewValue = clamp(
          drag.startValue + (coordinate(event) - drag.startCoordinate) * direction,
          propsRef.current.min,
          propsRef.current.max,
        );
        if (frameRef.current == null) frameRef.current = requestAnimationFrame(flushPreview);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        stop(true);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => cancel()}
      onLostPointerCapture={() => {
        if (dragRef.current) cancel();
      }}
      onDoubleClick={() => previewKeyboardValue(defaultValue)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        let next: number | null = null;
        if (event.key === "Home") next = defaultValue;
        else if (orientation === "vertical" && event.key === "ArrowLeft") {
          next = value - step * direction;
        } else if (orientation === "vertical" && event.key === "ArrowRight") {
          next = value + step * direction;
        } else if (orientation === "horizontal" && event.key === "ArrowUp") {
          next = value - step * direction;
        } else if (orientation === "horizontal" && event.key === "ArrowDown") {
          next = value + step * direction;
        }
        if (next == null) return;
        event.preventDefault();
        previewKeyboardValue(next);
      }}
    />
  );
}
