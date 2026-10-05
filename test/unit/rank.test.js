import { describe, expect, test } from "bun:test";
import {
  prominence,
  prominenceBucket,
  tierOf,
  TIER,
  distanceFromViewport,
  normalizeUrl,
  isInformativeLabel,
  mergeCandidates,
  rankCandidates,
} from "../../src/rank.js";

const VP = { width: 1000, height: 800 };
let n = 0;
// A plain, average link in the viewport.
const c = (over = {}) => ({
  url: `https://x.com/${n++}`,
  label: "link",
  source: "link",
  visible: true,
  inViewport: true,
  top: 100,
  left: 100,
  width: 80,
  height: 20,
  area: 1600,
  fontSize: 16,
  fontWeight: 400,
  headingLevel: 0,
  region: "",
  isImage: false,
  hasAlt: false,
  docIndex: n,
  ...over,
});
const urls = (items) => items.map((i) => i.url);

describe("prominence", () => {
  test("baseline link is near zero", () => {
    expect(prominence(c())).toBeCloseTo(Math.log2(1 + 1600 / 2000), 5);
  });
  test("bigger font, bold, headings, area and main content raise it", () => {
    const base = prominence(c());
    expect(prominence(c({ fontSize: 24 }))).toBeGreaterThan(base);
    expect(prominence(c({ fontWeight: 700 }))).toBe(base + 0.5);
    expect(prominence(c({ headingLevel: 1 }))).toBe(base + 3);
    expect(prominence(c({ headingLevel: 1 }))).toBeGreaterThan(prominence(c({ headingLevel: 3 })));
    expect(prominence(c({ area: 50000 }))).toBe(prominence(c({ area: 0 })) + 2); // clamped
    expect(prominence(c({ region: "main" }))).toBe(base + 1.5);
    expect(prominence(c({ isImage: true, hasAlt: true }))).toBe(base + 0.5);
  });
  test("nav/header/footer/aside and tiny fonts lower it", () => {
    const base = prominence(c());
    for (const region of ["nav", "header", "footer", "aside"]) {
      expect(prominence(c({ region }))).toBe(base - 2);
    }
    expect(prominence(c({ fontSize: 10 }))).toBe(base - 1); // clamped at -1
  });
  test("font size bonus is clamped at +3", () => {
    expect(prominence(c({ fontSize: 100 }))).toBe(prominence(c({ fontSize: 28 })));
  });
  test("buckets are coarse", () => {
    expect(prominenceBucket(c())).toBe(prominenceBucket(c({ fontWeight: 700 })));
    expect(prominenceBucket(c({ headingLevel: 1, region: "main" }))).toBeGreaterThan(prominenceBucket(c()));
    expect(prominenceBucket(c({ region: "nav" }))).toBeLessThan(prominenceBucket(c()));
  });
});

describe("tiers and distance", () => {
  test("tierOf", () => {
    expect(tierOf(c())).toBe(TIER.VIEWPORT);
    expect(tierOf(c({ inViewport: false }))).toBe(TIER.VISIBLE);
    expect(tierOf(c({ visible: false, inViewport: false }))).toBe(TIER.HIDDEN);
  });
  test("distanceFromViewport", () => {
    expect(distanceFromViewport(c(), VP)).toBe(0);
    expect(distanceFromViewport(c({ top: 1000 }), VP)).toBe(200);
    expect(distanceFromViewport(c({ top: -120, height: 20 }), VP)).toBe(100);
    expect(distanceFromViewport(c({ left: 1300 }), VP)).toBe(300);
  });
});

describe("normalizeUrl / labels", () => {
  test("drops only a bare trailing #", () => {
    expect(normalizeUrl("https://a.com/#")).toBe("https://a.com/");
    expect(normalizeUrl("https://a.com/page#intro")).toBe("https://a.com/page#intro");
    expect(normalizeUrl("https://a.com/?q=1")).toBe("https://a.com/?q=1");
  });
  test("isInformativeLabel", () => {
    expect(isInformativeLabel("Docs", "https://a.com")).toBe(true);
    expect(isInformativeLabel("", "https://a.com")).toBe(false);
    expect(isInformativeLabel("  ", "https://a.com")).toBe(false);
    expect(isInformativeLabel("https://a.com", "https://a.com")).toBe(false);
    expect(isInformativeLabel("www.a.com", "https://www.a.com")).toBe(false);
  });
});

describe("mergeCandidates", () => {
  test("dedupes by normalized URL, keeps best tier geometry and informative label", () => {
    const hiddenWithText = c({ url: "https://a.com/x", label: "Great article", visible: false, inViewport: false, docIndex: 1 });
    const visibleBare = c({ url: "https://a.com/x#", label: "https://a.com/x", source: "text", top: 300, docIndex: 5 });
    const [m] = mergeCandidates([hiddenWithText, visibleBare]);
    expect(m.url).toBe("https://a.com/x");
    expect(m.label).toBe("Great article");
    expect(tierOf(m)).toBe(TIER.VIEWPORT);
    expect(m.top).toBe(300);
    expect(m.docIndex).toBe(1);
    expect(m.count).toBe(2);
    expect(m.fromText).toBe(false);
  });
  test("prefers the label of the most prominent occurrence", () => {
    const small = c({ url: "https://a.com/y", label: "more", docIndex: 1 });
    const heading = c({ url: "https://a.com/y", label: "Big Story", headingLevel: 2, docIndex: 2 });
    expect(mergeCandidates([small, heading])[0].label).toBe("Big Story");
  });
  test("fragments are distinct URLs", () => {
    expect(mergeCandidates([c({ url: "https://a.com/#a" }), c({ url: "https://a.com/#b" })]).length).toBe(2);
  });
  test("text-only URLs are flagged fromText; labels are trimmed and NFC-normalized", () => {
    const [m] = mergeCandidates([c({ url: "https://a.com/z", label: " café ", source: "text" })]);
    expect(m.fromText).toBe(true);
    expect(m.label).toBe("café");
  });
  test("falls back to the URL when there is no label", () => {
    expect(mergeCandidates([c({ url: "https://a.com/q", label: "" })])[0].label).toBe("https://a.com/q");
  });
});

describe("rankCandidates", () => {
  test("tier dominates: viewport > visible off-screen > hidden, even against prominence", () => {
    const hidden = c({ visible: false, inViewport: false, headingLevel: 1, fontSize: 40 });
    const off = c({ inViewport: false, top: 2000, headingLevel: 1 });
    const inView = c({ region: "footer", fontSize: 11 });
    expect(urls(rankCandidates([hidden, off, inView], VP))).toEqual(urls([inView, off, hidden]));
  });
  test("in viewport: prominent first, then reading order (top, then left)", () => {
    const navA = c({ region: "nav", top: 10, left: 10 });
    const navB = c({ region: "nav", top: 10, left: 200 });
    const headline = c({ region: "main", headingLevel: 1, fontSize: 32, top: 80, area: 20000 });
    const body1 = c({ region: "main", top: 300, left: 400 });
    const body2 = c({ region: "main", top: 300, left: 100 });
    const body3 = c({ region: "main", top: 200, left: 700 });
    const ranked = rankCandidates([navA, navB, body1, headline, body2, body3], VP);
    expect(urls(ranked)).toEqual(urls([headline, body3, body2, body1, navA, navB]));
    expect(ranked.map((r) => r.rank)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  test("small prominence differences do not override reading order", () => {
    const first = c({ top: 100 });
    const boldLater = c({ top: 200, fontWeight: 700 });
    expect(urls(rankCandidates([boldLater, first], VP))).toEqual(urls([first, boldLater]));
  });
  test("off-screen visible: nearer first; prominence breaks ties within a distance band", () => {
    const far = c({ inViewport: false, top: 3000, headingLevel: 1 });
    const nearPlain = c({ inViewport: false, top: 900 });
    const nearProminent = c({ inViewport: false, top: 1000, headingLevel: 1, region: "main" });
    const above = c({ inViewport: false, top: -50, height: 20 });
    expect(urls(rankCandidates([far, nearPlain, nearProminent, above], VP))).toEqual(
      urls([nearProminent, above, nearPlain, far]),
    );
  });
  test("hidden: document order", () => {
    const h1 = c({ visible: false, inViewport: false, docIndex: 30 });
    const h2 = c({ visible: false, inViewport: false, docIndex: 10, headingLevel: 1 });
    const h3 = c({ visible: false, inViewport: false, docIndex: 20 });
    expect(urls(rankCandidates([h1, h2, h3], VP))).toEqual(urls([h2, h3, h1]));
  });
  test("duplicates merge into one ranked item at the best position", () => {
    const hidden = c({ url: "https://d.com/", visible: false, inViewport: false, label: "Dup" });
    const other = c({ top: 50 });
    const visible = c({ url: "https://d.com/#", top: 400 });
    const ranked = rankCandidates([hidden, other, visible], VP);
    expect(urls(ranked)).toEqual([other.url, "https://d.com/"]);
    expect(ranked[1].label).toBe("link"); // best occurrence's informative label wins
    expect(ranked[1].tier).toBe(TIER.VIEWPORT);
  });
});
