// Thin wrapper around fzf-for-js (vendored, BSD-3-Clause).
//
// Each item is matched as one fzf "line": `label + SEP + url`, so fzf's
// extended syntax works naturally: `^foo` anchors to the start of the label,
// `.pdf$` to the end of the URL, `'exact`, `!negate`, `a | b`, and
// space-separated terms are ANDed. Smart case: an uppercase letter in the
// query makes it case-sensitive.
//
// fzf's score is primary. fzf scores tie very often (e.g. "git" scores the
// same against "git", "GitHub" and "... github actions ..."), so ties are
// broken by, in order:
//   1. match quality (see matchQuality): exact label > label word-start match
//      > match entirely within the label > match that needs the URL
//   2. shorter label (fzf's default --tiebreak=length, but on the label only)
//   3. page rank (items must be passed in page-rank order)
//
// Positions are code-point indices (fzf works on runes), split back into
// label positions and URL positions for highlighting.

import { Fzf, extendedMatch } from "../vendor/fzf.es.js";

export const SEP = "  ";

const runeLength = (s) => Array.from(s).length;

export function haystack(item) {
  return item.label + SEP + item.url;
}

export function splitPositions(positions, item) {
  const labelLen = runeLength(item.label);
  const urlStart = labelLen + runeLength(SEP);
  const labelPositions = [];
  const urlPositions = [];
  for (const p of positions) {
    if (p < labelLen) labelPositions.push(p);
    else if (p >= urlStart) urlPositions.push(p - urlStart);
  }
  labelPositions.sort((a, b) => a - b);
  urlPositions.sort((a, b) => a - b);
  return { labelPositions, urlPositions };
}

// Best-effort parse of fzf extended syntax into OR-groups of positive terms
// (negations dropped; ' ^ $ stripped). Lowercased: quality is case-insensitive.
export function positiveTermGroups(query) {
  const groups = [];
  let current = [];
  let pendingOr = false;
  for (const tok of query.trim().split(/\s+/)) {
    if (tok === "|") {
      pendingOr = true;
      continue;
    }
    if (!pendingOr && current.length) {
      groups.push(current);
      current = [];
    }
    pendingOr = false;
    if (tok.startsWith("!")) continue;
    const term = tok.replace(/^['^]+/, "").replace(/\$$/, "").toLowerCase();
    if (term) current.push(term);
  }
  if (current.length) groups.push(current);
  return groups;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A term "starts a word" in text if it occurs at the start or right after a
// non-alphanumeric character (so "git" starts a word in "github actions").
function startsWord(text, term) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}`, "u").test(text);
}

export const QUALITY = { EXACT: 0, WORD: 1, LABEL: 2, URL: 3 };

// Lower is better.
export function matchQuality(result, groups) {
  const label = result.item.label.toLowerCase().trim();
  const positive = groups.map((g) => g[0]);
  if (groups.every((g) => g.length === 1) && positive.length && label === positive.join(" ")) return QUALITY.EXACT;
  if (groups.length && groups.every((g) => g.some((t) => startsWord(label, t)))) return QUALITY.WORD;
  if (result.urlPositions.length === 0 && result.labelPositions.length > 0) return QUALITY.LABEL;
  return QUALITY.URL;
}

const runeLen = (s) => Array.from(s).length;

export function createMatcher(items) {
  const order = new Map(items.map((item, i) => [item, i]));
  let groups = [];
  const cache = new Map(); // fzf result -> { quality, ... }
  const info = (r) => {
    let v = cache.get(r);
    if (!v) {
      v = { ...splitPositions(r.positions, r.item) };
      v.quality = matchQuality({ item: r.item, ...v }, groups);
      cache.set(r, v);
    }
    return v;
  };
  const byQuality = (a, b) => info(a).quality - info(b).quality;
  const byLabelLength = (a, b) => runeLen(a.item.label) - runeLen(b.item.label);
  const byPageRank = (a, b) => order.get(a.item) - order.get(b.item);
  const fzf = new Fzf(items, {
    selector: haystack,
    casing: "smart-case",
    match: extendedMatch,
    tiebreakers: [byQuality, byLabelLength, byPageRank],
  });
  return function match(query) {
    if (!query || !query.trim()) {
      return items.map((item) => ({ item, score: 0, labelPositions: [], urlPositions: [] }));
    }
    groups = positiveTermGroups(query);
    cache.clear();
    return fzf.find(query).map((r) => {
      const { labelPositions, urlPositions } = info(r);
      return { item: r.item, score: r.score, labelPositions, urlPositions };
    });
  };
}
