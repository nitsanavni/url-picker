// Popup: thin DOM layer over extract.js / rank.js / match.js / state.js.
import { extractLinks } from "./src/extract.js";
import { revealLink } from "./src/reveal.js";
import { rankCandidates, TIER } from "./src/rank.js";
import { createMatcher } from "./src/match.js";
import { initialState, reduce, keyCommand } from "./src/state.js";

const $ = (id) => document.getElementById(id);
const input = $("q");
const list = $("list");
const count = $("count");
const message = $("message");

const MAX_ROWS = 500; // rows rendered beyond the cursor window; counts stay exact

// Chrome never lets extensions script these.
const RESTRICTED = [
  /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|chrome-search|chrome-untrusted):/i,
  /^https:\/\/chromewebstore\.google\.com\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
];

let state = null;
let sourceTab = null;
let rendered = { results: null, selected: null, cursor: -1 };
let statusTimer = 0;

// `?tabId=N` lets tests point the popup (opened as a normal tab) at a page.
// In real use the popup targets the active tab of the current window.
async function getSourceTab() {
  const id = Number(new URLSearchParams(location.search).get("tabId"));
  if (Number.isInteger(id) && id > 0) return chrome.tabs.get(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showMessage(title, detail) {
  message.hidden = false;
  message.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = title;
  message.append(strong, document.createTextNode(detail || ""));
  list.replaceChildren();
}

async function init() {
  try {
    sourceTab = await getSourceTab();
  } catch (e) {
    return showMessage("Can't read this page", "No active tab.");
  }
  if (!sourceTab || (sourceTab.url && RESTRICTED.some((re) => re.test(sourceTab.url)))) {
    return showMessage("Can't read this page", "Chrome doesn't let extensions read browser pages or the Web Store.");
  }
  let data;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: sourceTab.id }, func: extractLinks });
    data = res && res.result;
  } catch (e) {
    console.warn("url-picker: executeScript failed", e);
    return showMessage("Can't read this page", "Chrome blocked access (browser page, Web Store, PDF viewer, or similar).");
  }
  if (!data || !Array.isArray(data.candidates)) {
    return showMessage("Can't read this page", "The page didn't return any data.");
  }
  const items = rankCandidates(data.candidates, data.viewport);
  if (!items.length) {
    showMessage("No links found", "This page has no http(s) links or URLs.");
  }
  state = initialState(items, createMatcher(items));
  render();
  input.focus();
}

function dispatch(action) {
  if (!state) return;
  const prevStatus = state.status;
  state = reduce(state, action);
  // Any new status message is transient.
  if (state.status && state.status !== prevStatus) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => dispatch({ type: "status", text: "" }), 1500);
  }
  render();
  if (state.effect) runEffect(state.effect);
}

async function runEffect(effect) {
  if (effect.type === "close") return window.close();
  if (effect.type === "open") {
    await openTabs(effect.urls);
    return window.close();
  }
  if (effect.type === "goto") {
    // Open the rest first: once the source tab navigates, its index is unchanged
    // but we want them right after it, in order.
    await openTabs(effect.urls.slice(1));
    await chrome.tabs.update(sourceTab.id, { url: effect.urls[0] });
    return window.close();
  }
  if (effect.type === "reveal") {
    let result = null;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: sourceTab.id },
        func: revealLink,
        args: [effect.locator],
      });
      result = res && res.result;
    } catch (e) {
      console.warn("url-picker: revealLink failed", e);
    }
    if (result && result.found) return window.close();
    return flashStatus(result && result.reason === "hidden" ? "hidden on page — can't scroll" : "link no longer on page");
  }
  if (effect.type === "copy") {
    const ok = await copyText(effect.urls.join("\n"));
    flashStatus(ok ? `copied ${effect.urls.length}` : "copy failed");
  }
}

async function openTabs(urls) {
  const base = sourceTab.index + 1;
  for (let i = 0; i < urls.length; i++) {
    await chrome.tabs.create({
      url: urls[i],
      index: base + i,
      active: false,
      openerTabId: sourceTab.id,
      windowId: sourceTab.windowId,
    });
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts where the async clipboard API is unavailable.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    input.focus();
    return ok;
  }
}

function flashStatus(text) {
  // Re-showing the same text still restarts the timer.
  if (state.status === text) dispatch({ type: "status", text: "" });
  dispatch({ type: "status", text });
}

// Wrap code points at `positions` in <mark>.
function highlight(el, text, positions) {
  if (!positions.length) {
    el.textContent = text;
    return;
  }
  const chars = Array.from(text);
  const set = new Set(positions);
  let buf = "";
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    if (inMark) {
      const m = document.createElement("mark");
      m.textContent = buf;
      el.append(m);
    } else el.append(buf);
    buf = "";
  };
  chars.forEach((ch, i) => {
    if (set.has(i) !== inMark) {
      flush();
      inMark = !inMark;
    }
    buf += ch;
  });
  flush();
}

function badgeFor(item) {
  if (item.tier === TIER.HIDDEN) return "hidden";
  if (item.tier === TIER.VISIBLE) return "off-screen";
  return item.fromText ? "text" : "";
}

function renderRow(r, i, selected) {
  const li = document.createElement("li");
  li.className = "row";
  li.setAttribute("role", "option");
  li.dataset.index = String(i);
  const isSel = selected.has(r.item.url);
  if (isSel) li.classList.add("selected");
  li.setAttribute("aria-selected", String(isSel));

  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = isSel ? "●" : "";
  const label = document.createElement("span");
  label.className = "label";
  highlight(label, r.item.label, r.labelPositions);
  const badge = document.createElement("span");
  const b = badgeFor(r.item);
  badge.className = b ? "badge" : "";
  badge.textContent = b && r.item.fromText && b !== "text" ? `${b} · text` : b;
  const url = document.createElement("span");
  url.className = "url";
  highlight(url, r.item.url, r.urlPositions);
  li.append(mark, label, badge, url);
  return li;
}

function render() {
  const { results, selected, cursor, query, status } = state;
  const countText = `${results.length}/${state.items.length}` + (selected.length ? ` · ${selected.length} selected` : "");
  count.replaceChildren(countText);
  if (status) {
    const s = document.createElement("span");
    s.className = "status";
    s.textContent = ` · ${status}`;
    count.append(s);
  }
  if (input.value !== query) input.value = query;

  if (rendered.results !== results || rendered.selected !== selected || cursor >= rendered.limit) {
    const limit = Math.min(results.length, Math.max(MAX_ROWS, cursor + 50));
    const sel = new Set(selected);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < limit; i++) frag.append(renderRow(results[i], i, sel));
    list.replaceChildren(frag);
    rendered = { results, selected, cursor: -1, limit };
  }
  if (rendered.cursor !== cursor) {
    list.querySelector(".row.hl")?.classList.remove("hl");
    const row = list.children[cursor];
    if (row) {
      row.classList.add("hl");
      row.scrollIntoView({ block: "nearest" });
    }
    rendered.cursor = cursor;
  }
}

input.addEventListener("input", () => dispatch({ type: "query", value: input.value }));

document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const command = keyCommand({
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    hasTextSelection: input.selectionStart !== input.selectionEnd,
  });
  if (!command) return;
  e.preventDefault();
  if (command === "close" && !state) return window.close();
  dispatch({ type: "command", command });
});

list.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) dispatch({ type: "click", index: Number(row.dataset.index), here: e.shiftKey });
});

// Keep typing going to the filter even after a click elsewhere.
document.addEventListener("mouseup", () => input.focus());

init();
