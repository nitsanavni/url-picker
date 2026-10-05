// revealLink(locator) runs inside the page via chrome.scripting.executeScript.
// Like extractLinks it MUST be self-contained (it is serialized).
//
// Re-finds a candidate from its locator (see extract.js), verifying the href /
// text still matches; if the DOM changed it falls back to searching by URL /
// text. Then scrolls it to the center, flashes an outline for ~1.5s (inline
// styles restored afterwards) and focuses it (links) or selects it (text URLs).
// Returns { found: boolean, kind?, reason? }.

export function revealLink(locator) {
  const FLASH_MS = 1500;
  const SKIP = new Set(["script", "style", "noscript", "textarea", "template", "select", "option"]);

  function resolve(el) {
    const raw = el.getAttribute("href");
    if (raw == null) return null;
    try {
      return new URL(raw.trim(), document.baseURI).href;
    } catch {
      return null;
    }
  }
  const sameUrl = (a, b) => a === b || a === b + "#" || a + "#" === b;

  function isShown(el) {
    if (!el || !el.getClientRects().length) return false;
    return typeof el.checkVisibility === "function"
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      : true;
  }

  function layoutElement(a) {
    if (a.localName !== "area") return a;
    const map = a.closest("map");
    return map && map.name ? document.querySelector(`img[usemap="#${CSS.escape(map.name)}"]`) : null;
  }

  function findLink(loc) {
    const all = document.querySelectorAll("a[href], area[href]");
    const at = all[loc.index];
    if (at && sameUrl(resolve(at), loc.url)) return at;
    const matches = Array.from(all).filter((a) => sameUrl(resolve(a), loc.url));
    return matches.find((a) => isShown(layoutElement(a))) || matches[0] || null;
  }

  function textNodes() {
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1 && SKIP.has(node.localName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const out = [];
    for (let n = walker.currentNode; n; n = walker.nextNode()) if (n.nodeType === 3) out.push(n);
    return out;
  }

  function findText(loc) {
    const nodes = textNodes();
    const n = nodes[loc.node];
    if (n && n.data.substr(loc.offset, loc.text.length) === loc.text) return { node: n, offset: loc.offset };
    for (const node of nodes) {
      const i = node.data.indexOf(loc.text);
      if (i >= 0 && !(node.parentElement && node.parentElement.closest("a[href]"))) return { node, offset: i };
    }
    return null;
  }

  function flash(el) {
    const props = ["outline", "outline-offset", "transition"];
    const saved = props.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
    el.style.setProperty("outline", "3px solid #f59e0b", "important");
    el.style.setProperty("outline-offset", "2px", "important");
    el.style.setProperty("transition", "none", "important");
    setTimeout(() => {
      for (const [p, v, prio] of saved) {
        if (v) el.style.setProperty(p, v, prio);
        else el.style.removeProperty(p);
      }
      if (el.getAttribute("style") === "") el.removeAttribute("style");
    }, FLASH_MS);
  }

  if (locator && locator.kind === "link") {
    const a = findLink(locator);
    const target = a && layoutElement(a);
    if (!a || !isShown(target)) return { found: false, reason: a ? "hidden" : "missing" };
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    flash(target);
    a.focus({ preventScroll: true });
    return { found: true, kind: "link" };
  }
  if (locator && locator.kind === "text") {
    const hit = findText(locator);
    const parent = hit && hit.node.parentElement;
    if (!hit || !isShown(parent)) return { found: false, reason: hit ? "hidden" : "missing" };
    const range = document.createRange();
    range.setStart(hit.node, hit.offset);
    range.setEnd(hit.node, hit.offset + locator.text.length);
    parent.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { found: true, kind: "text" };
  }
  return { found: false, reason: "bad-locator" };
}
