// End-to-end: load the unpacked extension in Chromium and drive the popup.
//
// The popup is opened as a normal tab (chrome-extension://<id>/popup.html?tabId=N)
// because Playwright can't press the toolbar button. That means activeTab is
// never granted, so the test runs a *copy* of the extension whose manifest adds:
//   - host_permissions for http://127.0.0.1/* (stands in for activeTab)
//   - the "tabs" permission, so the test can find tabs by URL
//   - "clipboardRead", so the test can read back what Ctrl+Y copied
//   - a no-op background service worker (to learn the extension id and to call
//     chrome.tabs.* from the test)
// The shipped manifest is untouched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium } from "playwright";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, serveFixtures } from "./helpers.js";

let context, sw, extId, server, base, userDataDir, buildDir;

function buildTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), "url-picker-ext-"));
  for (const f of ["popup.html", "popup.js", "popup.css", "src", "vendor", "icons"]) {
    cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://127.0.0.1/*"];
  manifest.permissions = [...manifest.permissions, "tabs", "clipboardRead"];
  manifest.background = { service_worker: "test-sw.js" };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "test-sw.js"), "// test-only service worker\n");
  return dir;
}

beforeAll(async () => {
  server = serveFixtures();
  base = `http://127.0.0.1:${server.port}`;
  buildDir = buildTestExtension();
  userDataDir = mkdtempSync(join(tmpdir(), "url-picker-profile-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: process.env.HEADED ? false : true,
    viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${buildDir}`, `--load-extension=${buildDir}`],
  });
  sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extId = new URL(sw.url()).host;
});

afterAll(async () => {
  await context?.close();
  server?.stop(true);
  for (const d of [userDataDir, buildDir]) if (d) rmSync(d, { recursive: true, force: true });
});

const allTabs = () =>
  sw.evaluate(async () =>
    (await chrome.tabs.query({})).map((t) => ({
      id: t.id,
      index: t.index,
      windowId: t.windowId,
      url: t.pendingUrl || t.url,
      active: t.active,
      openerTabId: t.openerTabId,
    })),
  );

async function openSource(path = "/page.html") {
  const page = await context.newPage();
  await page.goto(base + path);
  const tab = (await allTabs()).find((t) => t.url === base + path);
  return { page, tab };
}

async function openPopup(tabId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  return popup;
}

async function readyPopup(tabId) {
  const popup = await openPopup(tabId);
  await popup.locator(".row").first().waitFor();
  return popup;
}

const labels = (popup) => popup.locator(".row .label").allTextContents();
const count = (popup) => popup.locator("#count").textContent();
// Press a key that makes the popup close itself. The page may close between
// keydown and keyup, in which case Playwright reports a closed target: ignore it.
async function pressAndWaitClose(popup, key) {
  const closed = popup.waitForEvent("close");
  await popup.keyboard.press(key).catch(() => {});
  await closed;
}

async function waitForTabUrl(tabId, url) {
  for (let i = 0; i < 100; i++) {
    const t = (await allTabs()).find((t) => t.id === tabId);
    if (t && t.url === url) return t;
    await Bun.sleep(50);
  }
  throw new Error(`tab ${tabId} never reached ${url}`);
}

// Close everything but the first tab (closing the last tab would end the browser).
const closeTabsExcept = async () => {
  for (const p of context.pages().slice(1)) await p.close();
};

describe("URL Picker popup", () => {
  test("lists links in page-rank order with counts, badges and focus", async () => {
    const { page, tab } = await openSource();
    const popup = await readyPopup(tab.id);
    const l = await labels(popup);
    expect(l[0]).toBe("Big Story Headline");
    expect(l.indexOf("Card link")).toBeLessThan(l.indexOf("Home"));
    expect(l.indexOf("Home")).toBeLessThan(l.indexOf("Below the fold"));
    expect(l.indexOf("Below the fold")).toBeLessThan(l.indexOf("hidden by display"));
    expect(await count(popup)).toMatch(/^(\d+)\/\1$/);
    expect(await popup.locator(".row.hl .label").textContent()).toBe("Big Story Headline");
    expect(await popup.evaluate(() => document.activeElement.id)).toBe("q");
    const belowRow = popup.locator(".row", { hasText: "Below the fold" });
    expect(await belowRow.locator(".badge").textContent()).toBe("off-screen");
    const hiddenRow = popup.locator(".row", { hasText: "hidden by display" });
    expect(await hiddenRow.locator(".badge").textContent()).toBe("hidden");
    const textRow = popup.locator(".row", { hasText: "plain.example.com/doc" }).first();
    expect(await textRow.locator(".badge").textContent()).toBe("text");
    await closeTabsExcept([]);
  });

  test("typing filters immediately and highlights matches", async () => {
    const { tab } = await openSource();
    const popup = await readyPopup(tab.id);
    await popup.keyboard.type("bgstry");
    expect((await labels(popup))[0]).toBe("Big Story Headline");
    const total = (await count(popup)).split("/")[1];
    expect(await count(popup)).not.toBe(`${total}/${total}`);
    expect((await popup.locator(".row").first().locator(".label mark").allTextContents()).join("")).toBe("BgStry");
    await popup.keyboard.press("Backspace");
    await popup.keyboard.type("y .pdf$");
    expect(await popup.locator(".row").count()).toBe(0);
    expect(await count(popup)).toMatch(/^0\//);
    await closeTabsExcept([]);
  });

  test("Tab multi-select survives filter changes; Enter opens selected tabs in order next to the source", async () => {
    const { tab: source } = await openSource();
    // A tab to the right of the source, so "right after" is observable.
    const other = await context.newPage();
    await other.goto(base + "/other");
    const popup = await readyPopup(source.id);
    const q = popup.locator("#q");

    await q.fill("card link");
    await popup.keyboard.press("Tab");
    await q.fill("below");
    await popup.keyboard.press("Tab");
    await q.fill("relative");
    await popup.keyboard.press("Tab");
    await q.fill("");
    expect(await count(popup)).toMatch(/· 3 selected$/);
    expect(await popup.locator(".row.selected").count()).toBe(3);
    // toggling off from a different filter works too
    await q.fill("below");
    await popup.keyboard.press("Tab");
    expect(await count(popup)).toMatch(/· 2 selected$/);
    await q.fill("below");
    await popup.keyboard.press("Shift+Tab");
    expect(await count(popup)).toMatch(/· 3 selected$/);

    await pressAndWaitClose(popup, "Enter");

    const tabs = (await allTabs()).filter((t) => t.windowId === source.windowId).sort((a, b) => a.index - b.index);
    const src = tabs.find((t) => t.id === source.id);
    const next = tabs.slice(src.index + 1, src.index + 4);
    expect(next.map((t) => t.url)).toEqual([`${base}/card`, `${base}/relative/path?x=1`, `${base}/below`]);
    for (const t of next) {
      expect(t.openerTabId).toBe(source.id);
      expect(t.active).toBe(false);
    }
    expect(tabs[src.index + 4].url).toBe(`${base}/other`);
    await closeTabsExcept([]);
  });

  test("Enter without selection opens the highlighted item; arrows / Ctrl+N move", async () => {
    const { tab: source } = await openSource();
    const popup = await readyPopup(source.id);
    await popup.keyboard.type("^Home | ^About");
    const order = await labels(popup);
    expect(order.sort()).toEqual(["About", "Home"]);
    const [first, second] = await labels(popup);
    expect(await popup.locator(".row.hl .label").textContent()).toBe(first);
    await popup.keyboard.press("Control+n");
    expect(await popup.locator(".row.hl .label").textContent()).toBe(second);
    await popup.keyboard.press("Control+p");
    expect(await popup.locator(".row.hl .label").textContent()).toBe(first);
    await popup.keyboard.press("ArrowDown");
    await popup.keyboard.press("ArrowDown"); // clamped at the end
    await popup.keyboard.press("ArrowUp");
    await popup.keyboard.press("ArrowDown");
    expect(await popup.locator(".row.hl .label").textContent()).toBe(second);
    await pressAndWaitClose(popup, "Enter");
    const tabs = await allTabs();
    const src = tabs.find((t) => t.id === source.id);
    const opened = tabs.find((t) => t.windowId === src.windowId && t.index === src.index + 1);
    expect(opened.url).toBe(`${base}/${second.toLowerCase()}`);
    await closeTabsExcept([]);
  });

  test("Shift+Enter navigates the source tab and opens no new tab", async () => {
    const { tab: source } = await openSource();
    const popup = await readyPopup(source.id);
    const before = (await allTabs()).filter((t) => !t.url.startsWith("chrome-extension:")).length;
    await popup.keyboard.type("'Card link");
    await pressAndWaitClose(popup, "Shift+Enter");
    await waitForTabUrl(source.id, `${base}/card`);
    const tabs = await allTabs();
    expect(tabs.filter((t) => !t.url.startsWith("chrome-extension:")).length).toBe(before);
    await closeTabsExcept([]);
  });

  test("Shift+Enter with a selection: source goes to the first selected, the rest open after it", async () => {
    const { tab: source } = await openSource();
    const other = await context.newPage();
    await other.goto(base + "/other");
    const popup = await readyPopup(source.id);
    const q = popup.locator("#q");
    await q.fill("below");
    await popup.keyboard.press("Tab");
    await q.fill("card link");
    await popup.keyboard.press("Tab");
    await q.fill("relative");
    await popup.keyboard.press("Tab");
    await pressAndWaitClose(popup, "Shift+Enter");
    await waitForTabUrl(source.id, `${base}/below`);
    const tabs = (await allTabs()).filter((t) => t.windowId === source.windowId).sort((a, b) => a.index - b.index);
    const src = tabs.find((t) => t.id === source.id);
    expect(tabs.slice(src.index + 1, src.index + 4).map((t) => t.url)).toEqual([
      `${base}/card`,
      `${base}/relative/path?x=1`,
      `${base}/other`,
    ]);
    await closeTabsExcept([]);
  });

  test("Shift+click navigates the source tab to that row", async () => {
    const { tab: source } = await openSource();
    const popup = await readyPopup(source.id);
    const closed = popup.waitForEvent("close");
    await popup.locator(".row", { hasText: "Card link" }).click({ modifiers: ["Shift"] }).catch(() => {});
    await closed;
    await waitForTabUrl(source.id, `${base}/card`);
    await closeTabsExcept([]);
  });

  test("Ctrl+Y copies selected URLs (newline-separated) and keeps the popup open", async () => {
    const { tab: source } = await openSource();
    const popup = await readyPopup(source.id);
    await popup.keyboard.type("'inline");
    await popup.keyboard.press("Control+y");
    await popup.waitForFunction(() => document.querySelector("#count .status")?.textContent === " · copied 1");
    expect(await popup.evaluate(() => navigator.clipboard.readText())).toBe(`${base}/inline`);
    // selection order is preserved: select Home first, then About
    await popup.locator("#q").fill("^Home");
    await popup.keyboard.press("Tab");
    await popup.locator("#q").fill("^About");
    await popup.keyboard.press("Tab");
    await popup.keyboard.press("Control+y");
    await popup.waitForFunction(() => document.querySelector("#count .status")?.textContent === " · copied 2");
    expect(await popup.evaluate(() => navigator.clipboard.readText())).toBe(`${base}/home\n${base}/about`);
    expect(popup.isClosed()).toBe(false);
    await closeTabsExcept([]);
  });

  test("Escape closes the popup", async () => {
    const { tab: source } = await openSource();
    const popup = await readyPopup(source.id);
    await pressAndWaitClose(popup, "Escape");
    await closeTabsExcept([]);
  });

  test("clicking a row opens it", async () => {
    const { tab: source } = await openSource();
    const popup = await readyPopup(source.id);
    const closed = popup.waitForEvent("close");
    await popup.locator(".row", { hasText: "Card link" }).click().catch(() => {}); // may race the close
    await closed;
    const tabs = await allTabs();
    const src = tabs.find((t) => t.id === source.id);
    expect(tabs.find((t) => t.windowId === src.windowId && t.index === src.index + 1).url).toBe(`${base}/card`);
    await closeTabsExcept([]);
  });

  test("restricted or inaccessible pages show a clear message", async () => {
    // about:blank: rejected up front
    const blank = await context.newPage();
    const blankTab = (await allTabs()).find((t) => t.url === "about:blank");
    let popup = await openPopup(blankTab.id);
    await popup.locator("#message strong").waitFor();
    expect(await popup.locator("#message strong").textContent()).toBe("Can't read this page");
    // a site the extension has no access to: executeScript throws
    const page = await context.newPage();
    await page.goto(`http://localhost:${server.port}/page.html`);
    const noAccess = (await allTabs()).find((t) => t.url === `http://localhost:${server.port}/page.html`);
    popup = await openPopup(noAccess.id);
    await popup.locator("#message strong").waitFor();
    expect(await popup.locator("#message strong").textContent()).toBe("Can't read this page");
    expect(await popup.locator(".row").count()).toBe(0);
    await closeTabsExcept([]);
  });
});
