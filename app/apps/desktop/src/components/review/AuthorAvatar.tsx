import { monogram, safeColor, type ReviewAuthor } from "../../lib/review/model";

/** Monogram in the author's identity colour. The colour is validated (`safeColor`). */
export function AuthorAvatar({ author, size = "md" }: { author: ReviewAuthor; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      className={`review-avatar review-avatar--${size}`}
      style={{ background: safeColor(author.color) }}
      aria-hidden="true"
    >
      {monogram(author.displayName)}
    </span>
  );
}
