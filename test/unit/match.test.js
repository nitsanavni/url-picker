import { describe, expect, test } from "bun:test";
import { createMatcher, splitPositions, haystack, SEP, positiveTermGroups, matchQuality, QUALITY } from "../../src/match.js";
import { items as hn } from "./fixtures/hn-like.js";

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
    expect(labels(m("^Do"))).toEqual(["Download PDF", "Docs: Getting started"]); // tie -> shorter label
    expect(labels(m(".pdf$"))).toEqual(["Download PDF"]);
    expect(labels(m("'policy"))).toEqual(["Privacy policy"]);
    expect(labels(m("example !legal !pdf !docs"))).toEqual(["Home", "Pricing"]);
    expect(labels(m("^Home | ^Pricing")).sort()).toEqual(["Home", "Pricing"]);
    // 'exact must be contiguous: "pcy" is a fuzzy match of policy, not exact
    expect(labels(m("pcy"))).toContain("Privacy policy");
    expect(labels(m("'pcy"))).toEqual([]);
  });

  test("page rank breaks ties between equal fzf scores and equal labels", () => {
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

describe("tiebreakers", () => {
  test("repro: exact label beats word match beats long label on equal fzf score", () => {
    const its = [
      it("Some long story about github actions", "https://blog.example.com/1"),
      it("GitHub", "https://github.com/"),
      it("git", "https://git-scm.com/"),
    ];
    const m = createMatcher(its);
    const r = m("git");
    expect(new Set(r.map((x) => x.score)).size).toBe(1); // fzf ties them all
    expect(labels(r)).toEqual(["git", "GitHub", "Some long story about github actions"]);
    expect(labels(m("github"))).toEqual(["GitHub", "Some long story about github actions"]);
  });

  test("label match beats a URL-only match; shorter label beats longer", () => {
    const its = [it("Docs", "https://x.com/rust"), it("Rusty nails and more", "https://y.com/"), it("Rust stuff", "https://z.com/")];
    expect(labels(createMatcher(its)("rust"))).toEqual(["Rust stuff", "Rusty nails and more", "Docs"]);
  });

  test("fzf score stays primary over quality", () => {
    // fzf rewards word starts: "x g i t" outscores "legit", even though
    // "legit" would win on label length
    const its = [it("legit", "https://b.com/"), it("x g i t", "https://a.com/")];
    const r = createMatcher(its)("git");
    expect(r[0].score).toBeGreaterThan(r[1].score);
    expect(labels(r)).toEqual(["x g i t", "legit"]);
  });

  test("positiveTermGroups parses extended syntax best-effort", () => {
    expect(positiveTermGroups("Git")).toEqual([["git"]]);
    expect(positiveTermGroups("^hacker news$ !jobs 'faq")).toEqual([["hacker"], ["news"], ["faq"]]);
    expect(positiveTermGroups("rust | go  docs")).toEqual([["rust", "go"], ["docs"]]);
    expect(positiveTermGroups("!only")).toEqual([]);
  });

  test("matchQuality levels", () => {
    const r = (label, labelPositions = [0], urlPositions = []) => ({ item: it(label, "https://u.com/"), labelPositions, urlPositions });
    expect(matchQuality(r("Hacker News"), [["hacker"], ["news"]])).toBe(QUALITY.EXACT);
    expect(matchQuality(r("GitHub"), [["git"]])).toBe(QUALITY.WORD);
    expect(matchQuality(r("about github-actions"), [["actions"]])).toBe(QUALITY.WORD);
    expect(matchQuality(r("legit"), [["git"]])).toBe(QUALITY.LABEL);
    expect(matchQuality(r("Docs", [], [3]), [["rust"]])).toBe(QUALITY.URL);
    expect(matchQuality(r("Rust or Go"), [["python", "go"]])).toBe(QUALITY.WORD);
  });
});

describe("realistic ordering (news-site fixture)", () => {
  const m = createMatcher(hn);
  const top = (q, n = 3) => labels(m(q)).slice(0, n);
  const cases = {
    git: ["git", "GitHub", "github.com"],
    github: ["GitHub", "github.com", "Why we moved off GitHub"],
    rust: ["Rust", "rust-lang.org", "The Rust compiler is getting faster"],
    new: ["new", "Hacker News", "Postgres 19 beta: what's new"],
    comments: ["comments", "87 comments", "312 comments"],
    "hacker news": ["Hacker News"],
    api: ["API"],
    fzf: ["A gentle introduction to fzf"],
    show: ["show", "Show HN: A fuzzy URL picker for Chrome"],
    "^git": ["git", "GitHub", "github.com"],
    "'faq": ["FAQ"],
    "rust | git": ["Rust", "rust-lang.org", "The Rust compiler is getting faster", "git", "GitHub"],
  };
  for (const [q, expected] of Object.entries(cases)) {
    test(`"${q}" -> ${expected.join(" | ")}`, () => {
      expect(top(q, expected.length)).toEqual(expected);
    });
  }
  test("URL-only matches come after label matches on equal score", () => {
    // "ycombinator" appears only in URLs
    const r = m("ycombinator");
    expect(r.length).toBeGreaterThan(10);
    expect(r.every((x) => x.labelPositions.length === 0)).toBe(true);
  });
});
