// extractLinks() runs inside the page via chrome.scripting.executeScript({func}).
// It is serialized with Function.prototype.toString, so it MUST be fully
// self-contained: no imports, no references to anything outside its body.
//
// Returns { pageUrl, viewport: {width, height}, candidates: [...] } where each
// candidate carries raw layout/prominence features; scoring happens in rank.js.
// Each candidate also has a `locator` that revealLink() (src/reveal.js) uses to
// find the element again:
//   { kind: "link", index, url }  index into querySelectorAll("a[href], area[href]")
//   { kind: "text", node, offset, text, url }  node = index among text nodes
//     visited by the TreeWalker below (same SKIP filter), offset into its data
//
// Test hook: extractLinks({ textOnly: "some text" }) returns the plain-text URL
// matches for that string without touching the DOM (used by unit tests), and
// extractLinks({ readableUrl: "https://..." }) returns the URL-derived label.

export function extractLinks(opts) {
  // ---- plain-text URL detection -------------------------------------------
  // Stop at whitespace and " ' < > ` | \  (pipe: Slack renders <url|label>).
  const URL_RE = /(?<![\w.\/@-])(?:https?:\/\/|www\.)[^\s"'<>`|\\]+/gi;
  const TRAILING = /[.,;:!?…]$/;

  function count(s, ch) {
    let n = 0;
    for (const c of s) if (c === ch) n++;
    return n;
  }

  function cleanUrlText(raw) {
    let s = raw;
    const dash = s.search(/[—–]/); // em/en dash ends the URL
    if (dash >= 0) s = s.slice(0, dash);
    for (;;) {
      if (TRAILING.test(s)) s = s.slice(0, -1);
      else if (s.endsWith(")") && count(s, ")") > count(s, "(")) s = s.slice(0, -1);
      else if (s.endsWith("]") && count(s, "]") > count(s, "[")) s = s.slice(0, -1);
      else if (s.endsWith("}") && count(s, "}") > count(s, "{")) s = s.slice(0, -1);
      else break;
    }
    return s;
  }

  function findTextUrls(text) {
    const out = [];
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text))) {
      const t = cleanUrlText(m[0]);
      const isWww = /^www\./i.test(t);
      if (isWww ? !/^www\.[^./]+\.[^./]/i.test(t) : !/^https?:\/\/[^/?#]+/i.test(t)) continue;
      let url;
      try {
        url = new URL(isWww ? "https://" + t : t).href;
      } catch {
        continue;
      }
      out.push({ text: t, url, index: m.index, end: m.index + t.length });
    }
    return out;
  }

  // Readable fallback label from a URL: last path segment (decoded), else host.
  function readableUrl(url) {
    try {
      const u = new URL(url);
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length) {
        const last = segs[segs.length - 1];
        try {
          return decodeURIComponent(last);
        } catch {
          return last;
        }
      }
      return u.host;
    } catch {
      return url;
    }
  }

  if (opts && typeof opts.textOnly === "string") return findTextUrls(opts.textOnly);
  if (opts && typeof opts.readableUrl === "string") return readableUrl(opts.readableUrl);

  // ---- DOM extraction ------------------------------------------------------
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;

  function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
    }
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.opacity === "0") return false;
      if (e === el && cs.visibility !== "visible") return false;
    }
    return true;
  }

  function geometry(rectList) {
    const rects = Array.from(rectList).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity, area = 0;
    let inViewport = false;
    for (const r of rects) {
      top = Math.min(top, r.top);
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
      area += r.width * r.height;
      if (r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw) inViewport = true;
    }
    return { top, left, width: right - left, height: bottom - top, area, inViewport };
  }

  function region(el) {
    if (el.closest("nav, [role=navigation]")) return "nav";
    if (el.closest("aside, [role=complementary]")) return "aside";
    if (el.closest("main, article, [role=main], [role=article]")) return "main";
    if (el.closest("header, [role=banner]")) return "header";
    if (el.closest("footer, [role=contentinfo]")) return "footer";
    return "";
  }

  const HEADINGS = "h1, h2, h3, h4, h5, h6";
  function headingInfo(el) {
    const h = el.closest(HEADINGS) || el.querySelector(HEADINGS);
    return h ? { level: Number(h.tagName[1]), el: h } : { level: 0, el: null };
  }

  const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();

  function labelledBy(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    return collapse(ids.map((id) => document.getElementById(id)?.textContent || "").join(" "));
  }

  // Returns { label, fromUrl }. fromUrl = no real text was found, so the label
  // was derived from the URL (rank.js then withholds the area bonus).
  function anchorLabel(a, url) {
    const img = a.querySelector("img");
    const label =
      collapse(a.innerText) ||
      collapse(a.getAttribute("aria-label")) ||
      collapse(a.textContent) || // innerText is "" under visibility:hidden
      collapse(img && img.getAttribute("alt")) ||
      collapse(img && img.getAttribute("title")) ||
      labelledBy(a) ||
      collapse(a.closest("figure")?.querySelector("figcaption")?.textContent) ||
      collapse(a.getAttribute("title")) ||
      collapse(a.querySelector("svg title")?.textContent);
    return label ? { label, fromUrl: false } : { label: readableUrl(url), fromUrl: true };
  }

  function areaLabel(area, url) {
    const label = collapse(area.getAttribute("alt")) || collapse(area.getAttribute("aria-label")) || collapse(area.getAttribute("title"));
    return label ? { label, fromUrl: false } : { label: readableUrl(url), fromUrl: true };
  }

  function resolveHref(el) {
    const raw = el.getAttribute("href");
    // "" and "#" point back at this page (typically JS-driven buttons): skip.
    if (raw == null || raw.trim() === "" || raw.trim() === "#") return null;
    try {
      const u = new URL(raw.trim(), document.baseURI);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  }

  const candidates = [];
  let docIndex = 0;
  const linkIndex = new Map();
  document.querySelectorAll("a[href], area[href]").forEach((el, i) => linkIndex.set(el, i));
  let textNodeIndex = -1;

  function addAnchor(a) {
    const url = resolveHref(a);
    if (!url) return;
    let layoutEl = a;
    if (a.localName === "area") {
      const map = a.closest("map");
      layoutEl = map && map.name ? document.querySelector(`img[usemap="#${CSS.escape(map.name)}"]`) : null;
    }
    let geo = layoutEl ? geometry(layoutEl.getClientRects()) : null;
    // Inline anchors wrapping block content can report empty rects; fall back to children.
    if (layoutEl === a && (!geo || geo.area < 2)) {
      for (const child of a.querySelectorAll("*")) {
        const g = geometry(child.getClientRects());
        if (g && (!geo || g.area > geo.area)) geo = g;
      }
    }
    // sr-only style (1x1, clipped) counts as hidden.
    const visible = !!geo && geo.area >= 2 && isElementVisible(layoutEl);
    const heading = headingInfo(a);
    const cs = getComputedStyle(a);
    let fontSize = parseFloat(cs.fontSize) || 16;
    let fontWeight = parseInt(cs.fontWeight, 10) || 400;
    if (heading.el && a.contains(heading.el)) {
      const hs = getComputedStyle(heading.el);
      fontSize = Math.max(fontSize, parseFloat(hs.fontSize) || 0);
      fontWeight = Math.max(fontWeight, parseInt(hs.fontWeight, 10) || 0);
    }
    const img = a.localName === "area" ? layoutEl : a.querySelector("img");
    const lbl = a.localName === "area" ? areaLabel(a, url) : anchorLabel(a, url);
    candidates.push({
      url,
      label: lbl.label,
      labelFromUrl: lbl.fromUrl,
      source: "link",
      visible,
      inViewport: visible && geo.inViewport,
      top: geo ? geo.top : 0,
      left: geo ? geo.left : 0,
      width: geo ? geo.width : 0,
      height: geo ? geo.height : 0,
      area: visible ? geo.area : 0,
      fontSize,
      fontWeight,
      headingLevel: heading.level,
      region: region(a),
      isImage: !!img && !collapse(a.innerText),
      hasAlt: !!(img && collapse(img.getAttribute("alt"))),
      docIndex: docIndex++,
      locator: { kind: "link", index: linkIndex.get(a) ?? -1, url },
    });
  }

  function addTextUrls(node) {
    const text = node.data;
    if (!text || text.length < 8) return;
    const found = findTextUrls(text);
    if (!found.length) return;
    const parent = node.parentElement;
    const parentVisible = isElementVisible(parent);
    const cs = getComputedStyle(parent);
    const heading = headingInfo(parent);
    for (const f of found) {
      const range = document.createRange();
      range.setStart(node, f.index);
      range.setEnd(node, f.end);
      const geo = geometry(range.getClientRects());
      const visible = parentVisible && !!geo && geo.area >= 2;
      candidates.push({
        url: f.url,
        label: f.text,
        labelFromUrl: true,
        source: "text",
        visible,
        inViewport: visible && geo.inViewport,
        top: geo ? geo.top : 0,
        left: geo ? geo.left : 0,
        width: geo ? geo.width : 0,
        height: geo ? geo.height : 0,
        area: visible ? geo.area : 0,
        fontSize: parseFloat(cs.fontSize) || 16,
        fontWeight: parseInt(cs.fontWeight, 10) || 400,
        headingLevel: heading.level,
        region: region(parent),
        isImage: false,
        hasAlt: false,
        docIndex: docIndex++,
        locator: { kind: "text", node: textNodeIndex, offset: f.index, text: f.text, url: f.url },
      });
    }
  }

  const SKIP = new Set(["script", "style", "noscript", "textarea", "template", "select", "option"]);
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === 1 && SKIP.has(node.localName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  // Track whether we're inside an anchor: text inside links is not scanned.
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if ((node.localName === "a" || node.localName === "area") && node.hasAttribute("href")) addAnchor(node);
    } else {
      textNodeIndex++;
      if (!node.parentElement || !node.parentElement.closest("a[href]")) addTextUrls(node);
    }
  }

  return { pageUrl: location.href, title: document.title, viewport: { width: vw, height: vh }, candidates };
}
