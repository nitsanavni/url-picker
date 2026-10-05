// Picker state: a pure reducer. The popup is a thin DOM layer that dispatches
// actions and performs the resulting `effect` (open tabs / copy / close).
//
// state = {
//   items,      // ranked items (page-rank order)
//   match,      // (query) => results, from createMatcher(items)
//   query,
//   results,    // [{ item, score, labelPositions, urlPositions }]
//   cursor,     // index into results
//   selected,   // URLs, in the order they were selected
//   status,     // transient message, e.g. "copied 2"
//   effect,     // null | {type:'open', urls} | {type:'copy', urls} | {type:'close'}
// }

// Map a keyboard event to a picker command (or null = let the input have it).
export function keyCommand(e) {
  const { key, ctrlKey = false, metaKey = false, altKey = false, shiftKey = false } = e;
  if (altKey) return null;
  if (key === "Escape") return "close";
  if (key === "Enter") return "accept";
  if (key === "Tab") return shiftKey ? "toggleUp" : "toggleDown";
  if (key === "ArrowDown" && !ctrlKey && !metaKey) return "down";
  if (key === "ArrowUp" && !ctrlKey && !metaKey) return "up";
  if (key === "PageDown") return "pageDown";
  if (key === "PageUp") return "pageUp";
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (ctrlKey && !metaKey) {
    if (k === "n") return "down";
    if (k === "p") return "up";
    if (k === "y") return "copy";
  }
  // Cmd+C (mac) / Ctrl+C: copy URLs unless the user is copying selected query text.
  if ((metaKey || ctrlKey) && k === "c" && !e.hasTextSelection) return "copy";
  return null;
}

export const PAGE = 10;

export function initialState(items, match) {
  return withQuery(
    { items, match, query: null, results: [], cursor: 0, selected: [], status: "", effect: null },
    "",
  );
}

function withQuery(state, query) {
  if (query === state.query) return state;
  return { ...state, query, results: state.match(query), cursor: 0 };
}

const clampCursor = (state, cursor) =>
  Math.max(0, Math.min(cursor, Math.max(0, state.results.length - 1)));

function move(state, delta) {
  return { ...state, cursor: clampCursor(state, state.cursor + delta) };
}

function toggleHighlighted(state) {
  const r = state.results[state.cursor];
  if (!r) return state;
  const url = r.item.url;
  const selected = state.selected.includes(url)
    ? state.selected.filter((u) => u !== url)
    : [...state.selected, url];
  return { ...state, selected };
}

export function highlighted(state) {
  return state.results[state.cursor]?.item ?? null;
}

// URLs an action applies to: the selection (in selection order), else the highlighted item.
export function targetUrls(state) {
  if (state.selected.length) return [...state.selected];
  const h = highlighted(state);
  return h ? [h.url] : [];
}

export function reduce(state, action) {
  // Effects are one-shot: every action starts without one.
  const s = state.effect ? { ...state, effect: null } : state;
  switch (action.type) {
    case "query":
      return { ...withQuery(s, action.value), status: "" };
    case "status":
      return { ...s, status: action.text };
    case "click": {
      const r = s.results[action.index];
      return r ? { ...s, cursor: action.index, effect: { type: "open", urls: [r.item.url] } } : s;
    }
    case "command":
      switch (action.command) {
        case "down":
          return move(s, 1);
        case "up":
          return move(s, -1);
        case "pageDown":
          return move(s, PAGE);
        case "pageUp":
          return move(s, -PAGE);
        case "toggleDown":
          return move(toggleHighlighted(s), 1);
        case "toggleUp":
          return move(toggleHighlighted(s), -1);
        case "accept": {
          const urls = targetUrls(s);
          return urls.length ? { ...s, effect: { type: "open", urls } } : s;
        }
        case "copy": {
          const urls = targetUrls(s);
          return urls.length ? { ...s, effect: { type: "copy", urls } } : s;
        }
        case "close":
          return { ...s, effect: { type: "close" } };
      }
      return s;
  }
  return s;
}
