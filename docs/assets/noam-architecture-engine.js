/* ============================================================================
   rough-engine.js — seeded hand-drawn stroke engine for the chalkboard system
   ----------------------------------------------------------------------------
   WHAT IT IS
     A dependency-free renderer that turns laid-out DOM boxes and declarative
     <path data-r="..."> stubs into hand-drawn SVG strokes: double-pass jittered
     lines, rectangles whose corners overshoot and cross, ellipses that never
     quite close, and fills that spill a pixel or two past their nominal edge.
     It also owns the "stroke wipe" — paths draw themselves on as they scroll
     into view, via per-path stroke-dasharray.

   HOW TO INCLUDE IT
     No build step, no modules, no external requests. Either

       <script src="rough-engine.js"><\/script>         <!-- separate file -->

     or paste the whole file inside a <script> tag in your document. The second
     form is the point: this system's deliverable is usually ONE self-contained
     .html file that works from file:// with the network off. Nothing here uses
     import/export, fetch, or a CDN, so both forms behave identically.

     (The backslash above is not a typo. An HTML parser ends a <script> block at
     the first literal closing tag it sees, even inside a comment or a string —
     so this file never contains one. Do the same in any code you add.)

     Load it anywhere in <head> or <body>. It self-initialises on
     DOMContentLoaded (or immediately, if the DOM is already parsed).

   THE SEEDING RULE — the single most important rule in this file
     Every jittered coordinate comes from mulberry32(fnv(seedString)).
     NEVER Math.random(). NEVER Date.now(), performance.now(), or a frame time.
     The engine redraws on every resize, every font load, and every state
     change; if the jitter were random the whole board would shimmer and the
     drawing would stop reading as a physical object someone drew once. A shape
     drawn at width W must produce byte-identical path data every time it is
     drawn at width W, forever. Seeds are stable strings: an element's id, or a
     per-element counter assigned once (stableSeed), plus a literal suffix that
     distinguishes each stroke within that element ('|t', '|r', 'w'+i, ...).

   PUBLIC API — everything hangs off the single global `Chalk`
     Generators (pure, return SVG path `d` strings; all units are user units of
     the target SVG, which for this system is 1 unit = 1 CSS px):
       Chalk.roughLine(x1,y1,x2,y2,seed,amp)
       Chalk.roughPoly(points,seed,amp)
       Chalk.roughRect(x,y,w,h,seed,amp)
       Chalk.roughEllipse(cx,cy,rx,ry,seed,amp)
       Chalk.roughFill(x,y,w,h,seed,amp)
       Chalk.roughDash(x1,y1,x2,y2,seed,amp,dash,gap)
       Chalk.roughArrow(points,seed,amp,head)
     Wipe lifecycle:
       Chalk.armPath(path) / Chalk.playPath(path,delay,dur,ease)
       Chalk.unplayPath(path) / Chalk.showPath(path)
       Chalk.armAll(root) / Chalk.playAll(root)
     Renderers and layout:
       Chalk.registerRenderer(name, fn)   fn(svg, el, w, h)
       Chalk.registerPx(el) / Chalk.unregisterPx(el)
       Chalk.redraw()
     Geometry helpers for renderers:
       Chalk.rectIn(child,parent) / Chalk.edgeOf(R,ux,uy,pad)
       Chalk.connect(svg,A,B,seed,bow,cls,head)
     Plumbing renderers need:
       Chalk.addPath(svg,cls,d,style) / Chalk.layerFor(el,cls)
       Chalk.sizeLayer(svg,w,h) / Chalk.stableSeed(el) / Chalk.seeded(str)
       Chalk.applyDeclarative(root)
     Environment:
       Chalk.reduced()    prefers-reduced-motion: reduce
       Chalk.isStacked()  viewport is at/below the stacking breakpoint (780px)

   MARKUP CONTRACT
     .rbox            element gets a rough rectangular border drawn behind it
     .rcircle         element gets a rough elliptical border drawn behind it
     [data-px="name"] element gets a px-space <svg class="pxlayer"> and the
                      renderer registered under `name` is called to fill it
     path[data-r]     declarative shape; see applyDeclarative()
     .sketch          a path that participates in the stroke wipe
     .reveal          fades/slides in on scroll AND plays its sketch paths
     .wipe            plays its sketch paths on scroll without the fade
     .rbar            a rough-filled bar that scales in from the left
   ============================================================================ */

(function (global) {
  "use strict";

  var NS = 'http://www.w3.org/2000/svg';
  var doc = global.document;

  var mqReduce = global.matchMedia('(prefers-reduced-motion: reduce)');
  /* Connector geometry must be gated on the SAME breakpoint the stylesheet
     stacks at, not on raw container pixels. At a 700px viewport the containers
     still measure ~659px, so a px-width guard lets desktop connectors be drawn
     straight through what is actually a vertical stack. */
  var STACK_BREAKPOINT = 780;
  var mqStack = global.matchMedia('(max-width:' + STACK_BREAKPOINT + 'px)');

  /**
   * True when the user has asked for reduced motion. Every animated code path
   * checks this and jumps straight to the final rendering.
   * @returns {boolean}
   */
  function reduced() { return mqReduce.matches; }

  /**
   * True when the viewport is at or below the stacking breakpoint (780px).
   * Renderers that draw relationships only present in a multi-column layout
   * should bail out early on this rather than guessing from container width.
   * @returns {boolean}
   */
  function isStacked() { return mqStack.matches; }


  /* ==========================================================================
     1. Seeded rough-stroke engine (no dependencies)
     Every shape is keyed off a stable string seed, so the jitter never changes
     between redraws, resizes or re-selections.
     ========================================================================== */

  /** FNV-1a 32-bit string hash. Fast, no collisions that matter at this scale. */
  function fnv(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  /** mulberry32 PRNG. 32 bits of state, uniform enough for jitter. */
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Build a deterministic random source from a seed string.
   * Same string in, same sequence of numbers out, forever.
   * @param {string} s Seed string, e.g. 'card3|border'.
   * @returns {function(): number} Generator returning floats in [0,1).
   */
  function seeded(s) { return mulberry32(fnv(String(s))); }

  /** Round to 2dp so path data stays short and stable across redraws. */
  function n2(v) { return Math.round(v * 100) / 100; }

  /**
   * Catmull-Rom -> cubic bezier, so a jittered polyline reads as a drawn
   * stroke rather than a chain of straight segments.
   * @param {Array<[number,number]>} p Points in user units (px).
   * @returns {string} An SVG path `d` fragment beginning with M.
   */
  function bez(p) {
    if (p.length < 2) return '';
    var d = 'M' + n2(p[0][0]) + ' ' + n2(p[0][1]);
    if (p.length === 2) {
      var a = p[0], b = p[1];
      return d + ' C' + n2(a[0] + (b[0] - a[0]) / 3) + ' ' + n2(a[1] + (b[1] - a[1]) / 3) + ', ' +
        n2(a[0] + 2 * (b[0] - a[0]) / 3) + ' ' + n2(a[1] + 2 * (b[1] - a[1]) / 3) + ', ' +
        n2(b[0]) + ' ' + n2(b[1]);
    }
    for (var i = 0; i < p.length - 1; i++) {
      var p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p[i + 1];
      d += ' C' + n2(p1[0] + (p2[0] - p0[0]) / 6) + ' ' + n2(p1[1] + (p2[1] - p0[1]) / 6) + ', ' +
        n2(p2[0] - (p3[0] - p1[0]) / 6) + ' ' + n2(p2[1] - (p3[1] - p1[1]) / 6) + ', ' +
        n2(p2[0]) + ' ' + n2(p2[1]);
    }
    return d;
  }

  /**
   * A straight run drawn twice, each pass jittered independently, which is what
   * produces the overlapping off-register line a hand makes.
   * @param {number} x1 Start x, px.
   * @param {number} y1 Start y, px.
   * @param {number} x2 End x, px.
   * @param {number} y2 End y, px.
   * @param {string} seed Stable seed string.
   * @param {number} [amp=1.8] Jitter amplitude in px. 0.85 for icon-scale
   *   detail, ~1.5 for box borders, ~1.8 for free strokes.
   * @returns {string} SVG path `d` containing two subpaths.
   */
  function roughLine(x1, y1, x2, y2, seed, amp) {
    var A = amp || 1.8, r = seeded(seed + '|ln');
    var dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    var d = '';
    for (var pass = 0; pass < 2; pass++) {
      var a = A * (pass ? 1 : .82), j = function () { return (r() * 2 - 1) * a; };
      var sx = x1 + j() * .55, sy = y1 + j() * .55, ex = x2 + j() * .55, ey = y2 + j() * .55;
      var o1 = j(), o2 = j();
      d += 'M' + n2(sx) + ' ' + n2(sy) + ' C' + n2(x1 + dx * .32 + nx * o1) + ' ' + n2(y1 + dy * .32 + ny * o1) + ', ' +
        n2(x1 + dx * .68 + nx * o2) + ' ' + n2(y1 + dy * .68 + ny * o2) + ', ' + n2(ex) + ' ' + n2(ey) + ' ';
    }
    return d.trim();
  }

  /**
   * An open jittered polyline, drawn twice. Endpoints wobble less than interior
   * points (k=.6) so a connector still lands where it was aimed.
   * @param {Array<[number,number]>} pts Points in px.
   * @param {string} seed Stable seed string.
   * @param {number} [amp=1.8] Jitter amplitude in px.
   * @returns {string} SVG path `d` containing two subpaths.
   */
  function roughPoly(pts, seed, amp) {
    var A = amp || 1.8, r = seeded(seed + '|py');
    var d = '';
    for (var pass = 0; pass < 2; pass++) {
      var a = A * (pass ? 1 : .82);
      var j = pts.map(function (p, i) {
        var k = (i === 0 || i === pts.length - 1) ? .6 : 1;
        return [p[0] + (r() * 2 - 1) * a * k, p[1] + (r() * 2 - 1) * a * k];
      });
      d += (pass ? ' ' : '') + bez(j);
    }
    return d;
  }

  /**
   * A rectangle drawn as four independent sides, each overshooting its corners
   * by 2-5px so the corners cross instead of meeting. This is the single detail
   * that most separates "hand-drawn" from "a div with a border".
   * @param {number} x Left, px.
   * @param {number} y Top, px.
   * @param {number} w Width, px.
   * @param {number} h Height, px.
   * @param {string} seed Stable seed string.
   * @param {number} [amp=1.5] Jitter amplitude in px.
   * @returns {string} SVG path `d` containing eight subpaths (2 passes x 4 sides).
   */
  function roughRect(x, y, w, h, seed, amp) {
    /* cap the overshoot on small shapes, or a 12px chip looks like a scribble */
    var cap = Math.max(1, Math.min(5, Math.min(Math.abs(w), Math.abs(h)) * .22));
    var r = seeded(seed + '|rc'), o = function () { return Math.min(2 + r() * 3, cap); }, a = amp || 1.5;
    var t = o(), rt = o(), b = o(), l = o();
    return [
      roughLine(x - t, y, x + w + t, y, seed + '|t', a),
      roughLine(x + w, y - rt, x + w, y + h + rt, seed + '|r', a),
      roughLine(x + w + b, y + h, x - b, y + h, seed + '|b', a),
      roughLine(x, y + h + l, x, y - l, seed + '|l', a)
    ].join(' ');
  }

  /**
   * An ellipse as two overlapping passes that each start at a random angle and
   * stop short of closing, so the outline never looks machine-struck.
   * @param {number} cx Centre x, px.
   * @param {number} cy Centre y, px.
   * @param {number} rx Radius x, px.
   * @param {number} ry Radius y, px.
   * @param {string} seed Stable seed string.
   * @param {number} [amp=1.7] Jitter amplitude in px.
   * @returns {string} SVG path `d` containing two subpaths.
   */
  function roughEllipse(cx, cy, rx, ry, seed, amp) {
    var A = amp || 1.7, r = seeded(seed + '|el'), d = '';
    for (var pass = 0; pass < 2; pass++) {
      var N = 14, st = r() * 0.7, en = st + Math.PI * 2 - (0.09 + r() * 0.26), pts = [];
      for (var i = 0; i <= N; i++) {
        var t = st + (en - st) * i / N;
        var k = 1 + (r() * 2 - 1) * (A / Math.max(rx, ry, 1)) * 1.15;
        pts.push([cx + Math.cos(t) * rx * k + (r() * 2 - 1) * A * .3, cy + Math.sin(t) * ry * k + (r() * 2 - 1) * A * .3]);
      }
      d += (pass ? ' ' : '') + bez(pts);
    }
    return d;
  }

  /**
   * A closed, filled shape whose edge wobbles and spills 1-2px outside the
   * nominal rect — a chalk block someone scrubbed in, not a filled <rect>.
   * The returned path is meant to be used with fill and stroke:none.
   * @param {number} x Left, px.
   * @param {number} y Top, px.
   * @param {number} w Width, px.
   * @param {number} h Height, px.
   * @param {string} seed Stable seed string.
   * @param {number} [amp=1.5] Edge wobble amplitude in px.
   * @returns {string} A closed SVG path `d` ending in Z.
   */
  function roughFill(x, y, w, h, seed, amp) {
    var A = amp || 1.5, r = seeded(seed + '|fl');
    var edge = function (x1, y1, x2, y2, n) {
      var o = [];
      for (var i = 1; i <= n; i++) { var t = i / n; o.push([x1 + (x2 - x1) * t + (r() * 2 - 1) * A, y1 + (y2 - y1) * t + (r() * 2 - 1) * A]); }
      return o;
    };
    var nx = Math.max(3, Math.round(w / 24)), ny = Math.max(2, Math.round(h / 20));
    var pts = [[x + (r() * 2 - 1) * A, y + (r() * 2 - 1) * A]];
    pts = pts.concat(edge(x, y, x + w, y, nx), edge(x + w, y, x + w, y + h, ny), edge(x + w, y + h, x, y + h, nx), edge(x, y + h, x, y, ny));
    return bez(pts) + ' Z';
  }

  /**
   * A run of short rough segments — a hand-drawn dashed line. Real dashes
   * rather than stroke-dasharray, because the dash property is owned by the
   * stroke wipe and cannot be shared.
   * @param {number} x1 Start x, px.
   * @param {number} y1 Start y, px.
   * @param {number} x2 End x, px.
   * @param {number} y2 End y, px.
   * @param {string} seed Stable seed string.
   * @param {number} [amp=0.9] Jitter amplitude in px.
   * @param {number} [dash=6] Dash length, px.
   * @param {number} [gap=5] Gap length, px.
   * @returns {string} SVG path `d`.
   */
  function roughDash(x1, y1, x2, y2, seed, amp, dash, gap) {
    var D = dash || 6, G = gap || 5, L = Math.hypot(x2 - x1, y2 - y1) || 1;
    var ux = (x2 - x1) / L, uy = (y2 - y1) / L;
    var d = '', t = 0, k = 0;
    while (t < L - 1) {
      var e = Math.min(t + D, L);
      d += (d ? ' ' : '') + roughLine(x1 + ux * t, y1 + uy * t, x1 + ux * e, y1 + uy * e, seed + '|d' + (k++), amp || .9);
      t = e + G;
    }
    return d;
  }

  /**
   * A rough polyline with a two-stroke arrowhead at the last point. The head is
   * two separate short strokes, not a filled triangle.
   * @param {Array<[number,number]>} pts Points in px; direction is taken from
   *   the last two.
   * @param {string} seed Stable seed string.
   * @param {number} [amp=1.8] Jitter amplitude in px.
   * @param {number} [head=9] Arrowhead barb length, px.
   * @returns {string} SVG path `d`.
   */
  function roughArrow(pts, seed, amp, head) {
    var H = head || 9, d = roughPoly(pts, seed, amp);
    var b = pts[pts.length - 1], a = pts[pts.length - 2];
    var ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    return d + ' ' + roughPoly([[b[0] - Math.cos(ang - .42) * H, b[1] - Math.sin(ang - .42) * H], b], seed + '|h1', 1) +
      ' ' + roughPoly([[b[0] - Math.cos(ang + .42) * H, b[1] - Math.sin(ang + .42) * H], b], seed + '|h2', 1);
  }


  /* ==========================================================================
     2. Stroke-wipe plumbing (per-path dasharray, IntersectionObserver driven)
     ========================================================================== */

  /**
   * Put a path into the "not drawn yet" state: dasharray/dashoffset set to its
   * own length so nothing is visible. Under reduced motion this is a no-op that
   * leaves the path fully drawn.
   * @param {SVGPathElement} p
   * @returns {void}
   */
  function armPath(p) {
    if (reduced()) { p.style.strokeDasharray = ''; p.style.strokeDashoffset = '0'; p.dataset.armed = ''; return; }
    var L = 0;
    try { L = p.getTotalLength(); } catch (e) { L = 0; }
    if (!L) { p.style.strokeDashoffset = '0'; return; }
    L = Math.ceil(L) + 2;
    p.style.transition = 'none';
    p.style.strokeDasharray = L + ' ' + L;
    p.style.strokeDashoffset = L;
    p.dataset.armed = '1';
  }

  /**
   * Draw an armed path on. `dur`/`ease` are optional so callers can substitute
   * their own wipe timings (e.g. .26s small stroke / .64s large stroke) instead
   * of the default entrance wipe.
   * @param {SVGPathElement} p
   * @param {number} delay Stagger delay, milliseconds.
   * @param {string} [dur='.95s'] CSS duration.
   * @param {string} [ease='cubic-bezier(.25,.72,.3,1)'] CSS timing function.
   * @returns {void}
   */
  function playPath(p, delay, dur, ease) {
    /* armed==='2' means already playing or played. A nested wipe host (a
       [data-px] layer inside a .reveal) must not snap a running wipe to its
       end state. */
    if (p.dataset.armed === '2') return;
    if (p.dataset.armed !== '1') { p.style.strokeDashoffset = '0'; return; }
    p.dataset.armed = '2';
    requestAnimationFrame(function () {
      p.style.transition = 'stroke-dashoffset ' + (dur || '.95s') + ' ' + (ease || 'cubic-bezier(.25,.72,.3,1)') + ' ' + delay + 'ms' +
        ',stroke .18s ease,stroke-width .18s ease';
      p.style.strokeDashoffset = '0';
    });
  }

  /**
   * Put a path back to "not drawn yet" so a state change can re-wipe it.
   * @param {SVGPathElement} p
   * @returns {void}
   */
  function unplayPath(p) { p.style.transition = 'none'; armPath(p); }

  /**
   * Show a path immediately: no dash animation, and no inline transition left
   * behind, so the stylesheet's own stroke transitions stay in charge.
   * @param {SVGPathElement} p
   * @returns {void}
   */
  function showPath(p) { p.style.transition = ''; p.style.strokeDasharray = ''; p.style.strokeDashoffset = '0'; p.dataset.armed = ''; }

  /**
   * Arm every `path.sketch` under a root.
   * @param {Element} root
   * @returns {void}
   */
  function armAll(root) { root.querySelectorAll('path.sketch').forEach(armPath); }

  /**
   * Play every `path.sketch` under a root with a 70ms stagger (capped at
   * 700ms), and switch on any `.rbar` fills.
   * @param {Element} root
   * @returns {void}
   */
  function playAll(root) {
    var i = 0;
    root.querySelectorAll('path.sketch').forEach(function (p) { playPath(p, Math.min(i++ * 70, 700)); });
    root.querySelectorAll('.rbar').forEach(function (b, k) {
      if (reduced()) { b.classList.add('on'); return; }
      setTimeout(function () { b.classList.add('on'); }, 90 + k * 55);
    });
  }


  /* ==========================================================================
     3. Declarative shapes
     <path data-r="line|poly|arrow|rect|ellipse|fill" data-p="x,y x,y ...">
       data-p    whitespace-separated "x,y" pairs, in the host svg's user units
                 line/rect/ellipse/fill read exactly two pairs:
                   line    x1,y1 x2,y2
                   rect    x,y w,h
                   ellipse cx,cy rx,ry
                   fill    x,y w,h
                 poly/arrow read any number of pairs.
       data-seed optional stable seed; defaults to type+points+index
       data-amp  optional jitter amplitude in px
     ========================================================================== */

  /**
   * Expand every un-expanded `path[data-r]` under a root into real path data.
   * Idempotent: a path is only expanded once (marked with data-r-done), so the
   * declarative shapes survive redraws untouched.
   * @param {Document|Element} [root=document]
   * @returns {void}
   */
  function applyDeclarative(root) {
    (root || doc).querySelectorAll('path[data-r]').forEach(function (el, i) {
      if (el.dataset.rDone) return;
      var seed = el.dataset.seed || (el.dataset.r + '|' + el.dataset.p + '|' + i);
      var pts = (el.dataset.p || '').trim().split(/\s+/).map(function (s) { return s.split(',').map(Number); });
      var amp = parseFloat(el.dataset.amp) || (el.closest('.chalk-icon') ? .85 : undefined);
      var d = '';
      switch (el.dataset.r) {
        case 'line': d = roughLine(pts[0][0], pts[0][1], pts[1][0], pts[1][1], seed, amp); break;
        case 'poly': d = roughPoly(pts, seed, amp); break;
        case 'arrow': d = roughArrow(pts, seed, amp); break;
        case 'rect': d = roughRect(pts[0][0], pts[0][1], pts[1][0], pts[1][1], seed, amp); break;
        case 'ellipse': d = roughEllipse(pts[0][0], pts[0][1], pts[1][0], pts[1][1], seed, amp); break;
        case 'fill': d = roughFill(pts[0][0], pts[0][1], pts[1][0], pts[1][1], seed, amp); break;
      }
      el.setAttribute('d', d);
      el.dataset.rDone = '1';
    });
  }


  /* ==========================================================================
     4. Rough borders for laid-out boxes / circles (1 SVG unit = 1 CSS px)
     ========================================================================== */

  /**
   * Get (or create) the direct-child <svg> layer of `el` with class `cls`.
   * @param {Element} el
   * @param {string} cls 'rlayer' (borders) or 'pxlayer' (diagrams).
   * @returns {SVGSVGElement}
   */
  function layerFor(el, cls) {
    var s = el.querySelector(':scope > svg.' + cls);
    if (!s) {
      s = doc.createElementNS(NS, 'svg');
      s.setAttribute('class', cls);
      s.setAttribute('aria-hidden', 'true');
      el.insertBefore(s, el.firstChild);
    }
    return s;
  }

  /**
   * Set a layer's viewBox and size to the element's measured box and empty it.
   * viewBox is 0 0 w h with width/height w/h, i.e. 1 user unit = 1 CSS px, so
   * renderers can work in plain pixel coordinates.
   * @param {SVGSVGElement} s
   * @param {number} w Width, px.
   * @param {number} h Height, px.
   * @returns {SVGSVGElement} The same svg, now empty.
   */
  function sizeLayer(s, w, h) {
    s.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    s.setAttribute('width', w);
    s.setAttribute('height', h);
    s.innerHTML = '';
    return s;
  }

  /**
   * Append a path to a layer.
   * @param {SVGSVGElement} svg Target layer.
   * @param {string} cls Class list, e.g. 'doodle orange sketch'. Include
   *   'sketch' for anything that should take part in the stroke wipe.
   * @param {string} d Path data, normally from a rough* generator.
   * @param {Object<string,string>} [style] Inline style properties (camelCase).
   * @returns {SVGPathElement} The new path.
   */
  function addPath(svg, cls, d, style) {
    var p = doc.createElementNS(NS, 'path');
    if (cls) p.setAttribute('class', cls);
    p.setAttribute('d', d);
    if (style) for (var k in style) p.style[k] = style[k];
    svg.appendChild(p);
    return p;
  }

  var seedCounter = 0;
  /**
   * The element's stable seed: its id if it has one, otherwise a counter value
   * assigned once and cached on the element. Never derived from position, size
   * or time, so it survives resize and reflow.
   * @param {Element} el
   * @returns {string}
   */
  function stableSeed(el) {
    if (!el.__seed) el.__seed = el.id || ('n' + (seedCounter++));
    return el.__seed;
  }

  /** Draw a rough rectangular border into `el`'s rlayer. */
  function drawBox(el) {
    var w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    var svg = sizeLayer(layerFor(el, 'rlayer'), w, h);
    addPath(svg, 'sketch', roughRect(1, 1, w - 2, h - 2, stableSeed(el), 1.4));
    finish(el, svg);
  }

  /** Draw a rough elliptical border into `el`'s rlayer. */
  function drawCircle(el) {
    var w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    var svg = sizeLayer(layerFor(el, 'rlayer'), w, h);
    addPath(svg, 'sketch', roughEllipse(w / 2, h / 2, w / 2 - 2, h / 2 - 2, stableSeed(el), 1.5));
    finish(el, svg);
  }

  /* Only arm-and-wait when the host is genuinely observed by the wipe observer.
     A host that nothing observes must render immediately, otherwise its
     stroke-dashoffset is never released and the frame stays invisible forever. */
  function finish(el, svg) {
    var host = el.closest('.reveal,[data-px],.wipe');
    if (host && !host.__shown && wipeHosts.has(host)) { armAll(svg); return; }
    svg.querySelectorAll('path.sketch').forEach(showPath);
  }


  /* ==========================================================================
     5. px-space renderers: registration, geometry helpers, and the two
        content-free built-ins. Everything document-specific belongs in the
        consuming page, registered through Chalk.registerRenderer().
     ========================================================================== */

  var pxR = {};

  /**
   * Register a px-space renderer, callable from markup as [data-px="name"].
   * The renderer is invoked on first draw and again on every resize, with a
   * freshly emptied layer whose viewBox is 0 0 w h (1 unit = 1 CSS px).
   *
   * Inside a renderer: derive every seed from Chalk.stableSeed(el) plus a
   * literal suffix, and append with Chalk.addPath. Give paths the class
   * 'sketch' if they should wipe on. Bail out early (return before drawing) if
   * the current layout does not actually show the relationship you would be
   * asserting — see Chalk.isStacked().
   *
   * @param {string} name Value used in data-px.
   * @param {function(SVGSVGElement, Element, number, number): void} fn
   *   fn(svg, el, w, h) — layer, host element, width px, height px.
   * @returns {void}
   */
  function registerRenderer(name, fn) { pxR[name] = fn; }

  /**
   * A child's box in its parent's coordinate space — which is exactly the
   * pxlayer's coordinate space.
   * @param {Element} child
   * @param {Element} parent
   * @returns {{x:number,y:number,w:number,h:number,cx:number,cy:number,round:boolean}}
   *   Offsets and size in px, centre point, and whether the child is a
   *   .rcircle (so edgeOf can treat it as round).
   */
  function rectIn(child, parent) {
    var a = child.getBoundingClientRect(), b = parent.getBoundingClientRect();
    return {
      x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height,
      cx: a.left - b.left + a.width / 2, cy: a.top - b.top + a.height / 2,
      round: child.classList.contains('rcircle')
    };
  }

  /**
   * The point where a ray leaving a box's centre crosses its edge, pushed out
   * by `pad` so the stroke starts clear of the border.
   * @param {{cx:number,cy:number,w:number,h:number,round:boolean}} R A rectIn() result.
   * @param {number} ux Unit direction x.
   * @param {number} uy Unit direction y.
   * @param {number} pad Extra clearance in px.
   * @returns {[number,number]} Point in px.
   */
  function edgeOf(R, ux, uy, pad) {
    if (R.round) { var r = Math.min(R.w, R.h) / 2 + pad; return [R.cx + ux * r, R.cy + uy * r]; }
    var hw = R.w / 2 + pad, hh = R.h / 2 + pad;
    var t = Math.min(ux ? hw / Math.abs(ux) : 1e9, uy ? hh / Math.abs(uy) : 1e9);
    return [R.cx + ux * t, R.cy + uy * t];
  }

  /**
   * Draw an edge-to-edge connector between two boxes, bowed sideways so
   * parallel connectors do not overlap.
   * @param {SVGSVGElement} svg Target layer.
   * @param {object} A Source box from rectIn().
   * @param {object} B Target box from rectIn().
   * @param {string} seed Stable seed string.
   * @param {number} bow Sideways bow in px; sign picks the side. Clamped to
   *   16% of the connector length so long and short runs stay consistent.
   * @param {string} [cls='doodle sketch'] Class list for the path.
   * @param {boolean} [head] Pass false for a plain line with no arrowhead.
   * @returns {SVGPathElement}
   */
  function connect(svg, A, B, seed, bow, cls, head) {
    var dx = B.cx - A.cx, dy = B.cy - A.cy, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    var p1 = edgeOf(A, ux, uy, 6), p2 = edgeOf(B, -ux, -uy, 9);
    var seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    var bw = Math.sign(bow || 0) * Math.min(Math.abs(bow || 0), seg * .16);
    var mx = (p1[0] + p2[0]) / 2 - uy * bw, my = (p1[1] + p2[1]) / 2 + ux * bw;
    var pts = [p1, [mx, my], p2];
    return addPath(svg, cls || 'doodle sketch', head === false ? roughPoly(pts, seed, 1.7) : roughArrow(pts, seed, 1.7, 10));
  }

  /* Built-in: a section divider. A wobbling horizontal run with a small
     arrowhead at each end. Content-free ornament, sized to its host. */
  registerRenderer('divider', function (svg, el, w, h) {
    var y = h / 2, s = stableSeed(el);
    addPath(svg, 'doodle sketch', roughPoly([[10, y], [w * .28, y - 2.5], [w * .55, y + 2.5], [w * .8, y - 1], [w - 10, y]], s + 'd', 1.7));
    addPath(svg, 'doodle sketch', roughPoly([[18, y - 8], [10, y], [18, y + 8]], s + 'a1', 1.1));
    addPath(svg, 'doodle sketch', roughPoly([[w - 18, y - 8], [w - 10, y], [w - 18, y + 8]], s + 'a2', 1.1));
  });

  /* Built-in: the fill behind a .rbar. Width comes from CSS (--v is a
     percentage), colour from data-c, which names a CSS custom property. */
  registerRenderer('bar', function (svg, el, w, h) {
    var c = el.dataset.c || 'chalk';
    addPath(svg, '', roughFill(1.5, 1.5, Math.max(w - 3, 2), Math.max(h - 3, 2), stableSeed(el), 1.15),
      { fill: 'var(--' + c + ')', stroke: 'none' });
  });

  function renderPx(el) {
    var name = el.dataset.px, fn = pxR[name];
    if (!fn) return;
    var w = Math.round(el.clientWidth), h = Math.round(el.clientHeight);
    if (!w || !h) return;
    var svg = sizeLayer(layerFor(el, 'pxlayer'), w, h);
    fn(svg, el, w, h);
    /* same rule as finish(): never arm a layer nobody will play */
    if (!el.__shown && wipeHosts.has(el)) armAll(svg);
    else svg.querySelectorAll('path.sketch').forEach(showPath);
  }


  /* ==========================================================================
     6. Layout observation
     ========================================================================== */

  var boxes = [], circles = [], pxNodes = [], ro = null, raf = null;

  /* The set of hosts the scroll observer will actually play. Built before the
     first draw so finish()/renderPx() can tell "armed, will be played" apart
     from "armed, nobody is listening". */
  var wipeHosts = new Set();

  /**
   * Start drawing and observing a [data-px] element created after load. Nodes
   * added later missed the initial snapshot and the ResizeObserver, so without
   * this their viewBox goes stale on the next resize.
   * @param {Element} el An element carrying data-px.
   * @returns {void}
   */
  function registerPx(el) {
    if (pxNodes.indexOf(el) >= 0) return;
    stableSeed(el);
    pxNodes.push(el);
    if (ro) ro.observe(el);
  }

  /**
   * Stop drawing and observing a [data-px] element that is being removed.
   * @param {Element} el
   * @returns {void}
   */
  function unregisterPx(el) {
    var i = pxNodes.indexOf(el);
    if (i >= 0) pxNodes.splice(i, 1);
    if (ro) ro.unobserve(el);
  }

  function drawEverything() {
    if (pxNodes.some(function (n) { return !n.isConnected; })) {
      pxNodes = pxNodes.filter(function (n) { return n.isConnected; });
    }
    boxes.forEach(drawBox);
    circles.forEach(drawCircle);
    pxNodes.forEach(renderPx);
  }

  /**
   * Redraw every registered box, circle and px layer on the next frame.
   * Coalesced, so calling it repeatedly in one frame costs one redraw. Output
   * is identical for identical geometry — that is the seeding rule at work.
   * @returns {void}
   */
  function redraw() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () { raf = null; drawEverything(); });
  }


  /* ==========================================================================
     7. Reveal + wipe observer
     ========================================================================== */

  function init() {
    boxes = [].slice.call(doc.querySelectorAll('.rbox'));
    circles = [].slice.call(doc.querySelectorAll('.rcircle'));
    pxNodes = [].slice.call(doc.querySelectorAll('[data-px]'));
    boxes.forEach(stableSeed);
    circles.forEach(stableSeed);
    pxNodes.forEach(stableSeed);

    doc.querySelectorAll('.reveal,[data-px],.wipe').forEach(function (n) { wipeHosts.add(n); });

    applyDeclarative(doc);

    /* Inline declarative sketch paths sit inside registered wipe hosts but
       nothing else arms them, so without this they appear fully drawn with no
       wipe. Arm them here; playAll() releases them. */
    wipeHosts.forEach(function (h) {
      /* a host with no box (something display:none at this width) will never
         intersect, so arming it would strand its paths mid-wipe */
      if (!h.getClientRects().length) return;
      h.querySelectorAll('path.sketch[data-r]').forEach(armPath);
    });

    drawEverything();

    if ('ResizeObserver' in global) {
      ro = new ResizeObserver(redraw);
      boxes.concat(circles, pxNodes).forEach(function (n) { ro.observe(n); });
    }
    global.addEventListener('resize', redraw);
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(redraw).catch(function () {});

    var revObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var t = e.target;
        t.__shown = true;
        t.classList.add('visible');
        playAll(t);
        revObs.unobserve(t);
      });
    }, { threshold: .06, rootMargin: '0px 0px -6% 0px' });
    wipeHosts.forEach(function (n) { revObs.observe(n); });
  }


  /* ========================================================================== */

  var Chalk = {
    /* generators */
    roughLine: roughLine, roughPoly: roughPoly, roughRect: roughRect,
    roughEllipse: roughEllipse, roughFill: roughFill, roughDash: roughDash,
    roughArrow: roughArrow, bez: bez,
    /* wipe lifecycle */
    armPath: armPath, playPath: playPath, unplayPath: unplayPath,
    showPath: showPath, armAll: armAll, playAll: playAll,
    /* renderers + layout */
    registerRenderer: registerRenderer, registerPx: registerPx,
    unregisterPx: unregisterPx, redraw: redraw, applyDeclarative: applyDeclarative,
    /* geometry helpers */
    rectIn: rectIn, edgeOf: edgeOf, connect: connect,
    /* plumbing */
    layerFor: layerFor, sizeLayer: sizeLayer, addPath: addPath,
    stableSeed: stableSeed, seeded: seeded,
    /* environment */
    reduced: reduced, isStacked: isStacked
  };

  global.Chalk = Chalk;

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

})(window);
