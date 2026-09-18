/** The Noam Fan mark and live-text wordmark. Its two mask layers come from one
 * vector asset; theme tokens supply their colors and the blade gap stays clear. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={["wordmark", className].filter(Boolean).join(" ")}
      role="img"
      aria-label="Noam"
    >
      <span className="wordmark-mark" aria-hidden="true">
        <span className="wordmark-layer wordmark-back" />
        <span className="wordmark-layer wordmark-front" />
      </span>
      <span className="wordmark-name" aria-hidden="true">
        noam
      </span>
    </span>
  );
}
