import {
  WORDMARK_DARK_DATA_URI as WORDMARK_SILVER_URI,
  WORDMARK_LIGHT_DATA_URI as WORDMARK_INK_URI,
} from "../../brand-assets.js";

/**
 * Checkout success landing page (served at GET /api/billing/success).
 *
 * This is the page Polar's hosted checkout redirects to right after payment.
 * By the time it renders, the route has already confirmed the checkout with
 * Polar and written the subscription (see `billing.ts`), so this page has two
 * jobs: confirm the payment beautifully, and SEND THE USER BACK. It navigates
 * to the app's deep link (`<scheme>://billing/upgraded?org=…`) as soon as it
 * loads and offers the same link as a button, because a browser may refuse
 * the automatic hop to a custom scheme, and a person left on a "success" page
 * with no way onward assumes the app never noticed.
 *
 * Hard constraints (keep them intact):
 *  - Fully self-contained: no network requests, no CDN fonts, no remote images.
 *    System font stack only; the logo is inlined as base64 data URIs.
 *  - Works in both light and dark via prefers-color-scheme (checkout may open
 *    in either), and honours prefers-reduced-motion.
 *
 * Branding mirrors the desktop's Logo.tsx: the Paper & Ink Fan mark uses its
 * light or dark palette through a prefers-color-scheme media query.
 */

/** JS-string-literal escape for a value that is dropped inside `<script>`. */
const jsString = (v: string): string => JSON.stringify(v).replace(/</g, "\\u003c");
/** HTML attribute escape. */
const attr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function successPageHtml({ deepLink }: { deepLink: string }): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>You're on Pro — Noam</title>
<style>
  :root {
    color-scheme: light dark;
    --bg-0: #f2f1f6;
    --bg-1: #e9e7f1;
    --glow: rgba(127, 115, 255, 0.26);
    --ink: #17171c;
    --muted: #63636f;
    --faint: #9a9aa5;
    --accent: #6a5cf5;
    --accent-2: #7f73ff;
    --hairline: rgba(20, 20, 40, 0.10);
    --badge-ring: rgba(255, 255, 255, 0.9);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-0: #0a0b0f;
      --bg-1: #101218;
      --glow: rgba(127, 115, 255, 0.30);
      --ink: #f0f1f4;
      --muted: #9aa0ac;
      --faint: #6b6f7a;
      --accent: #8f84ff;
      --accent-2: #a49bff;
      --hairline: rgba(255, 255, 255, 0.10);
      --badge-ring: rgba(12, 13, 17, 0.85);
    }
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    color: var(--ink);
    background:
      radial-gradient(120% 80% at 50% -10%, var(--glow) 0%, transparent 55%),
      radial-gradient(100% 100% at 50% 120%, rgba(127,115,255,0.06) 0%, transparent 60%),
      linear-gradient(180deg, var(--bg-0) 0%, var(--bg-1) 100%);
    background-attachment: fixed;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: 6vh 24px;
  }

  .stage {
    width: 100%;
    max-width: 30rem;
    text-align: center;
  }

  /* Standalone success badge — the confirmation moment, above the wordmark */
  .badge {
    position: relative;
    width: 56px;
    height: 56px;
    margin: 0 auto 28px;
    border-radius: 50%;
    background: linear-gradient(150deg, var(--accent-2) 0%, var(--accent) 100%);
    box-shadow: 0 14px 34px -8px var(--glow), 0 0 0 4px var(--badge-ring);
    display: grid;
    place-items: center;
  }
  .badge::before {
    content: "";
    position: absolute;
    inset: -55%;
    border-radius: 50%;
    background: radial-gradient(circle, var(--glow) 0%, transparent 65%);
    filter: blur(6px);
    z-index: -1;
    animation: halo 5.5s ease-in-out infinite;
  }
  .badge svg { width: 26px; height: 26px; }
  .badge path {
    fill: none;
    stroke: #fff;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 22;
    stroke-dashoffset: 22;
    animation: draw .5s cubic-bezier(.65,0,.35,1) .55s forwards;
  }

  /* Noam Fan mark — Paper & Ink light/dark variants (mirrors Logo.tsx) */
  .wordmark { display: block; margin: 0 auto 30px; line-height: 0; }
  .wordmark img { width: 180px; height: auto; display: inline-block; }
  .wordmark img.wm-silver { display: none; }
  @media (prefers-color-scheme: dark) {
    .wordmark img.wm-ink { display: none; }
    .wordmark img.wm-silver { display: inline-block; }
  }

  .eyebrow {
    font-size: 0.72rem;
    font-weight: 650;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(1.9rem, 6vw, 2.5rem);
    font-weight: 640;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 16px;
  }
  .sub {
    font-size: 1.02rem;
    line-height: 1.6;
    color: var(--muted);
    margin: 0 auto;
    max-width: 21rem;
    text-align: center;
    text-wrap: balance;
  }

  .cta {
    display: inline-block;
    margin-top: 26px;
    padding: 12px 22px;
    border-radius: 999px;
    background: linear-gradient(150deg, var(--accent-2) 0%, var(--accent) 100%);
    color: #fff;
    font-weight: 600;
    font-size: 0.95rem;
    text-decoration: none;
    box-shadow: 0 10px 26px -10px var(--glow);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .cta:hover { transform: translateY(-1px); box-shadow: 0 14px 30px -10px var(--glow); }
  .cta:active { transform: none; }

  .foot {
    margin-top: 34px;
    padding-top: 22px;
    border-top: 1px solid var(--hairline);
    font-size: 0.86rem;
    color: var(--faint);
  }
  .foot a {
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: color .15s ease, border-color .15s ease;
  }
  .foot a:hover { color: var(--accent); border-color: var(--accent); }

  /* Staggered entrance */
  .reveal { opacity: 0; transform: translateY(14px); animation: rise .7s cubic-bezier(.22,1,.36,1) forwards; }
  .d1 { animation-delay: .05s; }
  .d2 { animation-delay: .16s; }
  .d3 { animation-delay: .26s; }
  .d4 { animation-delay: .36s; }
  .d5 { animation-delay: .46s; }
  .d6 { animation-delay: .6s; }

  @keyframes rise { to { opacity: 1; transform: none; } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes halo {
    0%, 100% { opacity: 0.7; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.06); }
  }

  @media (prefers-reduced-motion: reduce) {
    .reveal { opacity: 1; transform: none; animation: none; }
    .badge::before { animation: none; }
    .badge path { animation: none; stroke-dashoffset: 0; }
  }
</style>
</head>
<body>
  <main class="stage">
    <div class="badge reveal d1" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7"/></svg>
    </div>
    <span class="wordmark reveal d2" role="img" aria-label="Noam">
      <img class="wm-ink" src="${WORDMARK_INK_URI}" alt="" width="180" height="32">
      <img class="wm-silver" src="${WORDMARK_SILVER_URI}" alt="" width="180" height="32">
    </span>
    <p class="eyebrow reveal d3">Payment confirmed</p>
    <h1 class="reveal d4">You&rsquo;re on Pro</h1>
    <p class="sub reveal d5">Your vault is now unlimited. Taking you back to Noam&hellip;</p>
    <a class="cta reveal d5" href="${attr(deepLink)}">Open Noam</a>
    <div class="foot reveal d6">
      Didn&rsquo;t open? Use the button above, or switch to Noam &mdash; your subscription is already there.
      You can safely close this tab.
    </div>
  </main>
  <script>
    // Same hand-off as the account pages: hop into the app on load. The button
    // stays for browsers that only follow a custom scheme from a click.
    setTimeout(function () { location.href = ${jsString(deepLink)}; }, 600);
  </script>
</body></html>`;
}
