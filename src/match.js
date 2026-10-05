// Thin wrapper around fzf-for-js (vendored, BSD-3-Clause).
//
// Each item is matched as one fzf "line": `label + SEP + url`, so fzf's
// extended syntax works naturally: `^foo` anchors to the start of the label,
// `.pdf$` to the end of the URL, `'exact`, `!negate`, `a | b`, and
// space-separated terms are ANDed. Smart case: an uppercase letter in the
// query makes it case-sensitive.
//
// Items must be passed already sorted by page rank. fzf keeps input order
// among equal scores; we add an explicit tiebreaker on the input index so
// visible / prominent links win whenever fzf scores tie.
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

export function createMatcher(items) {
  const order = new Map(items.map((item, i) => [item, i]));
  const byPageRank = (a, b) => order.get(a.item) - order.get(b.item);
  const fzf = new Fzf(items, {
    selector: haystack,
    casing: "smart-case",
    match: extendedMatch,
    tiebreakers: [byPageRank],
  });
  return function match(query) {
    if (!query || !query.trim()) {
      return items.map((item) => ({ item, score: 0, labelPositions: [], urlPositions: [] }));
    }
    return fzf.find(query).map((r) => ({
      item: r.item,
      score: r.score,
      ...splitPositions(r.positions, r.item),
    }));
  };
}
