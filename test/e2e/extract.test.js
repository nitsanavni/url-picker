// Runs extractLinks() inside real Chromium layout against fixture pages.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium } from "playwright";
import { extractLinks } from "../../src/extract.js";
import { rankCandidates, TIER } from "../../src/rank.js";
import { serveFixtures } from "./helpers.js";

let browser, page, server, base, data, byUrl, ranked;

beforeAll(async () => {
  server = serveFixtures();
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}/page.html`);
  data = await page.evaluate(extractLinks);
  byUrl = (path) => data.candidates.filter((c) => c.url === (path.startsWith("http") ? path : base + path));
  ranked = rankCandidates(data.candidates, data.viewport);
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const one = (path) => {
  const found = byUrl(path);
  expect(found.length).toBe(1);
  return found[0];
};
const rankOf = (path) => ranked.findIndex((r) => r.url === (path.startsWith("http") ? path : base + path));

describe("extractLinks in Chromium", () => {
  test("reports page url and viewport", () => {
    expect(data.pageUrl).toBe(`${base}/page.html`);
    expect(data.viewport).toEqual({ width: 1280, height: 720 });
  });

  test("resolves relative hrefs and keeps only http(s)", () => {
    expect(one("/relative/path?x=1").label).toBe("relative link");
    expect(one("https://other.example.com/abs#frag").label).toBe("fragment link");
    const all = data.candidates.map((c) => c.url);
    for (const u of all) expect(u).toMatch(/^https?:\/\//);
    expect(all.some((u) => /javascript|mailto|tel:/.test(u))).toBe(false);
  });

  test("skips href='#' and empty href, and anchors without href", () => {
    const urls = data.candidates.map((c) => c.url);
    expect(urls).not.toContain(`${base}/page.html#`);
    expect(urls).not.toContain(`${base}/page.html`);
    expect(data.candidates.some((c) => c.label === "no href")).toBe(false);
  });

  test("label fallbacks: innerText, aria-label, img alt", () => {
    expect(one("/story").label).toBe("Big Story Headline");
    expect(one("/aria").label).toBe("Aria only");
    const img = one("/imglink");
    expect(img.label).toBe("Logo picture");
    expect(img.isImage).toBe(true);
    expect(img.hasAlt).toBe(true);
    expect(img.visible).toBe(true);
    expect(img.area).toBeGreaterThanOrEqual(120 * 60);
  });

  test("label fallbacks for links without text, else a readable URL", () => {
    expect(one("/labelledby")).toMatchObject({ label: "Labelled elsewhere", labelFromUrl: false });
    expect(one("/imgtitle")).toMatchObject({ label: "Image title", labelFromUrl: false });
    expect(one("/linktitle")).toMatchObject({ label: "Link title", labelFromUrl: false });
    expect(one("/figure")).toMatchObject({ label: "Figure caption text", labelFromUrl: false });
    const unlabeled = one("/wiki/File:Did_you_mean_andr%C3%A9.png");
    expect(unlabeled).toMatchObject({ label: "File:Did_you_mean_andré.png", labelFromUrl: true, visible: true, inViewport: true });
    expect(unlabeled.area).toBeGreaterThanOrEqual(300 * 200);
    expect(one("https://bare.example.com/")).toMatchObject({ label: "bare.example.com", labelFromUrl: true });
    expect(one("/story").labelFromUrl).toBe(false);
  });

  test("above vs below the fold", () => {
    expect(one("/story")).toMatchObject({ visible: true, inViewport: true });
    expect(one("/below")).toMatchObject({ visible: true, inViewport: false });
    expect(one("/below").top).toBeGreaterThan(720);
    expect(one("/terms")).toMatchObject({ visible: true, inViewport: false });
  });

  test("display:none, visibility:hidden, opacity:0 and sr-only are hidden", () => {
    for (const p of ["/hidden-display", "/hidden-visibility", "/hidden-opacity"]) {
      expect(one(p)).toMatchObject({ visible: false, inViewport: false });
    }
    expect(one("/hidden-visibility").label).toBe("hidden by visibility"); // textContent fallback
    expect(one("/page.html#main-content")).toMatchObject({ visible: false, label: "Skip to content" });
  });

  test("features: headings, font size, regions", () => {
    const story = one("/story");
    expect(story.headingLevel).toBe(1);
    expect(story.fontSize).toBeGreaterThan(24);
    expect(story.region).toBe("main");
    expect(one("/home").region).toBe("nav");
    expect(one("/related").region).toBe("aside");
    expect(one("/terms").region).toBe("footer");
    expect(one("/small").fontSize).toBe(11);
    expect(one("/card").area).toBeGreaterThanOrEqual(400 * 150);
  });

  test("plain-text URLs: found with geometry, punctuation stripped; not inside links/script/textarea", () => {
    const plain = one("https://plain.example.com/doc");
    expect(plain).toMatchObject({ source: "text", label: "https://plain.example.com/doc", visible: true, inViewport: true });
    expect(plain.width).toBeGreaterThan(50);
    expect(one("https://www.text-www.example.org/page").label).toBe("www.text-www.example.org/page");
    expect(one("https://far.example.com/x")).toMatchObject({ source: "text", visible: true, inViewport: false });
    expect(one("https://hidden-text.example.com/")).toMatchObject({ source: "text", visible: false });
    // the URL text inside the <a> is the anchor, not an extra text candidate
    expect(byUrl("https://linked.example.com/").map((c) => c.source)).toEqual(["link"]);
    const urls = data.candidates.map((c) => c.url);
    expect(urls.some((u) => u.includes("in-script"))).toBe(false);
    expect(urls.some((u) => u.includes("in-textarea"))).toBe(false);
  });

  test("locators point back at the element / text node", async () => {
    const below = one("/below");
    expect(below.locator).toMatchObject({ kind: "link", url: `${base}/below` });
    const href = await page.evaluate((i) => document.querySelectorAll("a[href], area[href]")[i].getAttribute("href"), below.locator.index);
    expect(href).toBe("/below");
    const far = one("https://far.example.com/x");
    expect(far.locator).toMatchObject({ kind: "text", text: "https://far.example.com/x" });
    expect(far.locator.node).toBeGreaterThanOrEqual(0);
    expect(far.locator.offset).toBe("Far plain text ".length);
  });

  test("duplicates are reported separately, in document order", () => {
    const dups = byUrl("/dup");
    expect(dups.length).toBe(2);
    expect(dups[0].docIndex).toBeLessThan(dups[1].docIndex);
    expect(dups[0].inViewport).toBe(true);
  });
});

describe("ranking real layout", () => {
  test("dedupes /dup with the visible, informative occurrence", () => {
    const d = ranked.filter((r) => r.url === `${base}/dup`);
    expect(d.length).toBe(1);
    expect(d[0]).toMatchObject({ label: "Dup informative label", tier: TIER.VIEWPORT, count: 2 });
  });

  test("tiers: in-viewport, then visible off-screen (nearest first), then hidden", () => {
    const tiers = ranked.map((r) => r.tier);
    expect([...tiers].sort()).toEqual(tiers);
    expect(rankOf("/below")).toBeLessThan(rankOf("/very-far"));
    expect(rankOf("/very-far")).toBeLessThan(rankOf("/hidden-display"));
    expect(rankOf("/hidden-display")).toBeLessThan(rankOf("/hidden-visibility"));
  });

  test("prominent main-content links beat nav and small links in the viewport", () => {
    expect(rankOf("/story")).toBe(0);
    expect(rankOf("/card")).toBeLessThan(rankOf("/inline"));
    expect(rankOf("/inline")).toBeLessThan(rankOf("/home"));
    expect(rankOf("/inline")).toBeLessThan(rankOf("/related"));
    expect(rankOf("/small")).toBeLessThan(rankOf("/home"));
  });

  test("a big unlabeled image link ranks below normal text links in main", () => {
    const img = rankOf("/wiki/File:Did_you_mean_andr%C3%A9.png");
    expect(img).toBeGreaterThan(rankOf("/inline"));
    expect(img).toBeGreaterThan(rankOf("/relative/path?x=1"));
    expect(img).toBeGreaterThan(rankOf("/card"));
  });

  test("reading order within the same prominence bucket", () => {
    expect(rankOf("/inline")).toBeLessThan(rankOf("/small"));
    expect(rankOf("/home")).toBeLessThan(rankOf("/about"));
  });
});
