/**
 * What "New dashboard" writes: the frontmatter that makes the note a
 * dashboard and one example view (recently modified notes, as cards), so the
 * new note shows something useful the moment it opens and teaches the
 * grammar by example.
 */
export const NEW_DASHBOARD_NAME = "Dashboard";

export const NEW_DASHBOARD_TEMPLATE = [
  "---",
  "noam_kind: dashboard",
  "---",
  "",
  "```noam-view",
  "title: Recently modified",
  "view: cards",
  "sort: modified desc",
  "limit: 12",
  "```",
  "",
].join("\n");
