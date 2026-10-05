import { describe, expect, test } from "bun:test";
import { createMatcher } from "../../src/match.js";
import { initialState, reduce, keyCommand, highlighted, targetUrls, PAGE } from "../../src/state.js";

const items = [
  { label: "Alpha", url: "https://a.com/alpha" },
  { label: "Beta", url: "https://a.com/beta" },
  { label: "Gamma", url: "https://a.com/gamma" },
  { label: "Delta", url: "https://a.com/delta" },
  { label: "Alphabet soup", url: "https://soup.com/" },
];
const start = () => initialState(items, createMatcher(items));
const cmd = (command) => ({ type: "command", command });
const run = (state, ...actions) => actions.reduce(reduce, state);
const typed = (q) => ({ type: "query", value: q });
const labels = (s) => s.results.map((r) => r.item.label);

describe("keyCommand", () => {
  test("navigation keys", () => {
    expect(keyCommand({ key: "ArrowDown" })).toBe("down");
    expect(keyCommand({ key: "ArrowUp" })).toBe("up");
    expect(keyCommand({ key: "n", ctrlKey: true })).toBe("down");
    expect(keyCommand({ key: "p", ctrlKey: true })).toBe("up");
    expect(keyCommand({ key: "N", ctrlKey: true, shiftKey: true })).toBe("down");
    expect(keyCommand({ key: "PageDown" })).toBe("pageDown");
    expect(keyCommand({ key: "PageUp" })).toBe("pageUp");
  });
  test("selection, accept, close", () => {
    expect(keyCommand({ key: "Tab" })).toBe("toggleDown");
    expect(keyCommand({ key: "Tab", shiftKey: true })).toBe("toggleUp");
    expect(keyCommand({ key: "Enter" })).toBe("accept");
    expect(keyCommand({ key: "Escape" })).toBe("close");
  });
  test("copy: Ctrl+Y always, Cmd/Ctrl+C only without a text selection in the input", () => {
    expect(keyCommand({ key: "y", ctrlKey: true })).toBe("copy");
    expect(keyCommand({ key: "c", metaKey: true })).toBe("copy");
    expect(keyCommand({ key: "c", ctrlKey: true })).toBe("copy");
    expect(keyCommand({ key: "c", metaKey: true, hasTextSelection: true })).toBe(null);
  });
  test("plain typing and unrelated chords are left to the input", () => {
    expect(keyCommand({ key: "a" })).toBe(null);
    expect(keyCommand({ key: "n" })).toBe(null);
    expect(keyCommand({ key: "Backspace" })).toBe(null);
    expect(keyCommand({ key: "a", ctrlKey: true })).toBe(null);
    expect(keyCommand({ key: "ArrowDown", altKey: true })).toBe(null);
    expect(keyCommand({ key: "y" })).toBe(null);
  });
});

describe("reduce", () => {
  test("initial state lists everything with cursor on the first item", () => {
    const s = start();
    expect(labels(s)).toEqual(items.map((i) => i.label));
    expect(s.cursor).toBe(0);
    expect(highlighted(s)).toBe(items[0]);
    expect(s.selected).toEqual([]);
    expect(s.effect).toBe(null);
  });

  test("typing filters and resets the cursor to the top", () => {
    const s = run(start(), cmd("down"), cmd("down"), typed("alp"));
    expect(labels(s)).toEqual(["Alpha", "Alphabet soup"]);
    expect(s.cursor).toBe(0);
  });

  test("cursor is clamped to the result list", () => {
    let s = run(start(), cmd("up"));
    expect(s.cursor).toBe(0);
    s = run(s, typed("alp"), cmd("down"), cmd("down"), cmd("down"));
    expect(s.cursor).toBe(1);
    s = run(start(), cmd("pageDown"));
    expect(s.cursor).toBe(items.length - 1);
    s = run(s, cmd("pageUp"));
    expect(s.cursor).toBe(0);
    expect(PAGE).toBeGreaterThan(1);
  });

  test("no results: cursor 0, nothing highlighted, Enter does nothing", () => {
    const s = run(start(), typed("zzzzqqq"));
    expect(s.results).toEqual([]);
    expect(s.cursor).toBe(0);
    expect(highlighted(s)).toBe(null);
    expect(run(s, cmd("down")).cursor).toBe(0);
    expect(run(s, cmd("accept")).effect).toBe(null);
    expect(run(s, cmd("toggleDown")).selected).toEqual([]);
  });

  test("Tab toggles the highlighted item and moves down; Shift+Tab toggles and moves up", () => {
    let s = run(start(), cmd("toggleDown"));
    expect(s.selected).toEqual(["https://a.com/alpha"]);
    expect(s.cursor).toBe(1);
    s = run(s, cmd("toggleDown"));
    expect(s.selected).toEqual(["https://a.com/alpha", "https://a.com/beta"]);
    s = run(s, cmd("toggleUp")); // toggles Gamma (cursor 2), moves to 1
    expect(s.selected).toEqual(["https://a.com/alpha", "https://a.com/beta", "https://a.com/gamma"]);
    expect(s.cursor).toBe(1);
    s = run(s, cmd("toggleUp")); // un-toggles Beta
    expect(s.selected).toEqual(["https://a.com/alpha", "https://a.com/gamma"]);
    expect(s.cursor).toBe(0);
  });

  test("Tab on the last item toggles and stays", () => {
    const s = run(start(), typed("soup"), cmd("toggleDown"));
    expect(s.selected).toEqual(["https://soup.com/"]);
    expect(s.cursor).toBe(0);
  });

  test("selection persists across filter changes (keyed by URL)", () => {
    let s = run(start(), typed("gam"), cmd("toggleDown"), typed("del"), cmd("toggleDown"), typed(""));
    expect(s.selected).toEqual(["https://a.com/gamma", "https://a.com/delta"]);
    // still marked when visible again, and can be un-toggled from any filter
    s = run(s, typed("gamma"), cmd("toggleDown"));
    expect(s.selected).toEqual(["https://a.com/delta"]);
  });

  test("Enter opens the selection in selection order, including filtered-out items", () => {
    const s = run(start(), typed("del"), cmd("toggleDown"), typed("alpha"), cmd("toggleDown"), typed("beta"), cmd("accept"));
    expect(s.effect).toEqual({ type: "open", urls: ["https://a.com/delta", "https://a.com/alpha"] });
  });

  test("Enter without a selection opens the highlighted item", () => {
    const s = run(start(), typed("ga"), cmd("accept"));
    expect(s.effect).toEqual({ type: "open", urls: ["https://a.com/gamma"] });
    const s2 = run(start(), cmd("down"), cmd("accept"));
    expect(s2.effect).toEqual({ type: "open", urls: ["https://a.com/beta"] });
  });

  test("Escape closes", () => {
    expect(run(start(), cmd("close")).effect).toEqual({ type: "close" });
  });

  test("copy targets selection, else highlighted; effect is one-shot", () => {
    let s = run(start(), cmd("down"), cmd("copy"));
    expect(s.effect).toEqual({ type: "copy", urls: ["https://a.com/beta"] });
    s = run(s, cmd("down"));
    expect(s.effect).toBe(null);
    s = run(s, cmd("toggleDown"), cmd("toggleDown"), cmd("copy"));
    expect(s.effect).toEqual({ type: "copy", urls: ["https://a.com/gamma", "https://a.com/delta"] });
    expect(targetUrls(s)).toEqual(["https://a.com/gamma", "https://a.com/delta"]);
  });

  test("status is set by the popup and cleared by typing", () => {
    let s = run(start(), { type: "status", text: "copied 2" });
    expect(s.status).toBe("copied 2");
    s = run(s, typed("a"));
    expect(s.status).toBe("");
  });

  test("click opens that row", () => {
    const s = run(start(), { type: "click", index: 3 });
    expect(s.effect).toEqual({ type: "open", urls: ["https://a.com/delta"] });
    expect(run(start(), { type: "click", index: 99 }).effect).toBe(null);
  });

  test("unchanged query keeps the cursor", () => {
    const s = run(start(), typed("a"), cmd("down"), typed("a"));
    expect(s.cursor).toBe(1);
  });
});
