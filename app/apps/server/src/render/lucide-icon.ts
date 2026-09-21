import {
  LUCIDE_ALIASES,
  LUCIDE_NODES,
  type LucideNode,
} from "./lucide-icons.generated.js";

const ICON_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICON_COLORS = new Set([
  "violet", "blue", "teal", "green", "amber", "orange", "rose", "slate",
]);

function escapeAttribute(value: string | number): string {
  return String(value).replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function serializeNode([tag, attributes]: LucideNode): string {
  const serialized = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  return `<${tag}${serialized}></${tag}>`;
}

/** Render only geometry copied from the pinned Lucide catalogue. */
export function renderLucideIcon(id: string, color: string | undefined): string | null {
  if (id.length > 80 || !ICON_ID.test(id)) return null;
  const canonical = Object.hasOwn(LUCIDE_NODES, id) ? id : LUCIDE_ALIASES[id];
  if (!canonical) return null;
  const nodes = LUCIDE_NODES[canonical];
  if (!nodes) return null;
  const colorClass = color && ICON_COLORS.has(color) ? ` icon-color-${color}` : "";
  return `<svg class="note-icon note-icon-lucide${colorClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${nodes.map(serializeNode).join("")}</svg>`;
}
