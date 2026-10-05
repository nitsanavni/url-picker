// Page ranking: turns raw candidates from extractLinks() into a deduped list
// ordered so that what you can see, and what stands out, comes first.
//
// Tiers (dominant):
//   0  in viewport        visible and intersecting the viewport
//   1  visible off-screen rendered, but scrolled out of view
//   2  hidden             display:none, visibility:hidden, opacity 0, zero size
//
// Within tier 0: prominence bucket (desc), then reading order (top, then left).
// Within tier 1: distance band (half-viewport-heights away, asc), then
//                prominence bucket (desc), then exact distance, then doc order.
// Within tier 2: document order.
//
// Prominence weights (see prominence()):
//   font size     (px - 16) / 4, clamped to [-1, +3]   (12px -> -1, 28px -> +3)
//   bold          +0.5 when font-weight >= 600
//   heading       h1 +3, h2 +2.5, h3 +2, h4 +1.5, h5 +1, h6 +0.5
//   area          log2(1 + px² / 2000), clamped to [0, +3]
//                 (a 100x20 link = +1, a 200x80 button ≈ +3.2 -> +3)
//   region        main/article +1.5; nav/header/footer/aside -2
//   image link    +0.5 for an image link with alt text
// Bucket = floor(prominence / BUCKET). Coarse buckets mean small differences
// don't override reading order; only clearly more prominent links jump ahead.

export const TIER = { VIEWPORT: 0, VISIBLE: 1, HIDDEN: 2 };
export const BUCKET = 2;

const HEADING_BONUS = [0, 3, 2.5, 2, 1.5, 1, 0.5];
const REGION_BONUS = { main: 1.5, nav: -2, header: -2, footer: -2, aside: -2 };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function prominence(c) {
  let s = 0;
  if (Number.isFinite(c.fontSize)) s += clamp((c.fontSize - 16) / 4, -1, 3);
  if (c.fontWeight >= 600) s += 0.5;
  s += HEADING_BONUS[c.headingLevel] || 0;
  if (c.area > 0) s += clamp(Math.log2(1 + c.area / 2000), 0, 3);
  s += REGION_BONUS[c.region] || 0;
  if (c.isImage && c.hasAlt) s += 0.5;
  return s;
}

export const prominenceBucket = (c) => Math.floor(prominence(c) / BUCKET);

export function tierOf(c) {
  if (!c.visible) return TIER.HIDDEN;
  return c.inViewport ? TIER.VIEWPORT : TIER.VISIBLE;
}

// Distance in px from the candidate's box to the viewport (0 if it overlaps).
export function distanceFromViewport(c, viewport) {
  const top = c.top ?? 0;
  const left = c.left ?? 0;
  const bottom = top + (c.height ?? 0);
  const right = left + (c.width ?? 0);
  const dy = bottom < 0 ? -bottom : top > viewport.height ? top - viewport.height : 0;
  const dx = right < 0 ? -right : left > viewport.width ? left - viewport.width : 0;
  return Math.hypot(dx, dy);
}

// Only a trailing bare "#" is dropped; real fragments (#section) are kept.
export function normalizeUrl(url) {
  return url.endsWith("#") ? url.slice(0, -1) : url;
}

const looksLikeUrl = (s) => /^(https?:\/\/|www\.)/i.test(s);

export function isInformativeLabel(label, url) {
  if (!label) return false;
  const l = label.trim();
  return l.length > 0 && l !== url && !looksLikeUrl(l);
}

// Comparison used both to pick the best duplicate and inside tiers.
function betterCandidate(a, b) {
  const ta = tierOf(a), tb = tierOf(b);
  if (ta !== tb) return ta - tb;
  return prominence(b) - prominence(a);
}

// Dedupe by normalized URL. The merged item keeps the geometry/features of its
// best occurrence (best tier, then most prominent) and the most informative
// label (first informative label in best-first order, else the best's label).
export function mergeCandidates(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const url = normalizeUrl(c.url);
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push(c);
  }
  const merged = [];
  for (const [url, group] of groups) {
    const sorted = [...group].sort(betterCandidate);
    const best = sorted[0];
    const informative = sorted.find((c) => isInformativeLabel(c.label, c.url));
    const label = ((informative || best).label || url).trim();
    const sources = [...new Set(group.map((c) => c.source || "link"))];
    merged.push({
      ...best,
      url,
      label: label.normalize("NFC"),
      docIndex: Math.min(...group.map((c) => c.docIndex ?? Infinity)),
      count: group.length,
      fromText: sources.every((s) => s === "text"),
    });
  }
  return merged;
}

export function compareRanked(a, b, viewport) {
  const ta = tierOf(a), tb = tierOf(b);
  if (ta !== tb) return ta - tb;
  if (ta === TIER.VIEWPORT) {
    return (
      prominenceBucket(b) - prominenceBucket(a) ||
      (a.top ?? 0) - (b.top ?? 0) ||
      (a.left ?? 0) - (b.left ?? 0) ||
      (a.docIndex ?? 0) - (b.docIndex ?? 0)
    );
  }
  if (ta === TIER.VISIBLE) {
    const band = Math.max(1, viewport.height / 2);
    const da = distanceFromViewport(a, viewport), db = distanceFromViewport(b, viewport);
    return (
      Math.floor(da / band) - Math.floor(db / band) ||
      prominenceBucket(b) - prominenceBucket(a) ||
      da - db ||
      (a.docIndex ?? 0) - (b.docIndex ?? 0)
    );
  }
  return (a.docIndex ?? 0) - (b.docIndex ?? 0);
}

// Full pipeline: dedupe + sort. Returns items with `rank` (0 = best) and `tier`.
export function rankCandidates(candidates, viewport = { width: 1280, height: 720 }) {
  return mergeCandidates(candidates)
    .sort((a, b) => compareRanked(a, b, viewport))
    .map((c, rank) => ({ ...c, rank, tier: tierOf(c) }));
}
