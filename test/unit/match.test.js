import { describe, expect, test } from "bun:test";
import { createMatcher, splitPositions, haystack, SEP } from "../../src/match.js";

const it = (label, url) => ({ label, url });
const labels = (results) => results.map((r) => r.item.label);

const items = [
  it("Home", "https://example.com/"),
  it("Pricing", "https://example.com/pricing"),
  it("GitHub repository", "https://github.com/acme/widget"),
  it("Docs: Getting started", "https://docs.example.com/start"),
  it("Download PDF", "https://example.com/files/report.pdf"),
  it("Privacy policy", "https://example.com/legal/privacy"),
];

describe("createMatcher", () => {
  test("empty / whitespace query returns all items in input (page-rank) order", () => {
    const m = createMatcher(items);
    expect(labels(m(""))).toEqual(items.map((i) => i.label));
    expect(labels(m("   "))).toEqual(items.map((i) => i.label));
    expect(m("")[0]).toEqual({ item: items[0], score: 0, labelPositions: [], urlPositions: [] });
  });

  test("fuzzy subsequence filters and ranks better matches first", () => {
    const m = createMatcher(items);
    const r = m("prv");
    expect(labels(r)).toEqual(["Privacy policy"]);
    // "gh" matches GitHub's word start strongly
    expect(labels(m("git"))[0]).toBe("GitHub repository");
  });

  test("matches against the URL too", () => {
    const m = createMatcher(items);
    // fuzzy "acme" also loosely matches a..c..m..e elsewhere, but the
    // contiguous URL match ranks first
    const r = m("acme");
    expect(r[0].item.label).toBe("GitHub repository");
    expect(r[0].labelPositions).toEqual([]);
    const url = Array.from(r[0].item.url);
    expect(r[0].urlPositions.map((p) => url[p]).join("")).toBe("acme");
    expect(labels(m("'acme"))).toEqual(["GitHub repository"]);
  });

  test("smart case: lowercase is insensitive, uppercase is sensitive", () => {
    const m = createMatcher([it("PDF guide", "https://a.com/x"), it("pdf notes", "https://a.com/y")]);
    expect(labels(m("pdf")).sort()).toEqual(["PDF guide", "pdf notes"]);
    expect(labels(m("PDF"))).toEqual(["PDF guide"]);
  });

  test("space-separated terms are ANDed (across label and URL)", () => {
    const m = createMatcher(items);
    expect(labels(m("example pricing"))).toEqual(["Pricing"]);
    expect(labels(m("download pdf"))).toEqual(["Download PDF"]);
    expect(m("nomatch pricing")).toEqual([]);
  });

  test("extended syntax: ^prefix, suffix$, 'exact, !negation, a | b", () => {
    const m = createMatcher(items);
    expect(labels(m("^Do"))).toEqual(["Docs: Getting started", "Download PDF"]);
    expect(labels(m(".pdf$"))).toEqual(["Download PDF"]);
    expect(labels(m("'policy"))).toEqual(["Privacy policy"]);
    expect(labels(m("example !legal !pdf !docs"))).toEqual(["Home", "Pricing"]);
    expect(labels(m("^Home | ^Pricing")).sort()).toEqual(["Home", "Pricing"]);
    // 'exact must be contiguous: "pcy" is a fuzzy match of policy, not exact
    expect(labels(m("pcy"))).toContain("Privacy policy");
    expect(labels(m("'pcy"))).toEqual([]);
  });

  test("page rank breaks ties between equal fzf scores", () => {
    const a = it("Read more", "https://x.com/a");
    const b = it("Read more", "https://x.com/b");
    const c = it("Read more", "https://x.com/c");
    expect(createMatcher([a, b, c])("read").map((r) => r.item)).toEqual([a, b, c]);
    expect(createMatcher([c, a, b])("read").map((r) => r.item)).toEqual([c, a, b]);
  });

  test("a clearly better fzf match beats page rank", () => {
    const weak = it("Some page with r e a d letters", "https://x.com/1");
    const strong = it("Read", "https://x.com/2");
    expect(createMatcher([weak, strong])("read")[0].item).toBe(strong);
  });

  test("label positions are code-point indices usable for highlighting", () => {
    const m = createMatcher([it("café ☕ menu", "https://x.com/m")]);
    const r = m("menu")[0];
    const chars = Array.from("café ☕ menu");
    expect(r.labelPositions.map((p) => chars[p]).join("")).toBe("menu");
  });
});

describe("splitPositions", () => {
  test("splits haystack positions into label and url parts, skipping the separator", () => {
    const item = it("ab", "https://c");
    expect(haystack(item)).toBe("ab" + SEP + "https://c");
    const urlStart = 2 + SEP.length;
    const r = splitPositions(new Set([1, 0, 2, 3, urlStart, urlStart + 8]), item);
    expect(r).toEqual({ labelPositions: [0, 1], urlPositions: [0, 8] });
  });
});
