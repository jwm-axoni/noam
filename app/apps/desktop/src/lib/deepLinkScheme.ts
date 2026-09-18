// Which `<scheme>://` this build of the app owns, and which ones its link
// parsers accept.
//
// The released app registers `noam://`; the Staging app registers
// `noam-staging://` (tauri.staging.conf.json overrides the deep-link schemes,
// and staging-release.yml inlines VITE_DEEP_LINK_SCHEME to match). They HAVE to
// differ: with both apps installed on one machine and both claiming `noam://`,
// the OS hands every link — a production invitation email included — to
// whichever app registered the scheme last, which is how clicking a link from
// the production server opened the Staging app.
//
// Parsers accept both schemes regardless of build. Being strict about the
// scheme buys nothing (the OS already routed the link here) and would make a
// link pasted between builds silently do nothing.

/** The scheme this build registers and puts in links it constructs itself. */
export const APP_SCHEME: string =
  (import.meta.env.VITE_DEEP_LINK_SCHEME as string | undefined)?.trim() || "noam";

// `thread:` stays accepted so links minted by older builds keep working; new
// links always use APP_SCHEME.
const ACCEPTED_PROTOCOLS = new Set(["thread:", "noam-staging:", `${APP_SCHEME}:`]);

/** Is this `URL.protocol` (with its trailing colon) one of ours? */
export function isAppProtocol(protocol: string): boolean {
  return ACCEPTED_PROTOCOLS.has(protocol);
}
