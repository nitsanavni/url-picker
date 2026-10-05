import { describe, expect, test } from "bun:test";
import { extractLinks } from "../../src/extract.js";

const find = (text) => extractLinks({ textOnly: text });
const texts = (text) => find(text).map((m) => m.text);
const urls = (text) => find(text).map((m) => m.url);

describe("plain-text URL detection", () => {
  test("finds http and https URLs with positions", () => {
    const s = "see https://example.com/a?b=1#c and http://foo.org";
    const r = find(s);
    expect(r.map((m) => m.text)).toEqual(["https://example.com/a?b=1#c", "http://foo.org"]);
    for (const m of r) expect(s.slice(m.index, m.end)).toBe(m.text);
    expect(r[1].url).toBe("http://foo.org/");
  });

  test("strips trailing sentence punctuation", () => {
    expect(texts("Go to https://a.com/x.")).toEqual(["https://a.com/x"]);
    expect(texts("https://a.com/x, https://b.com/y; https://c.com/z: done")).toEqual([
      "https://a.com/x",
      "https://b.com/y",
      "https://c.com/z",
    ]);
    expect(texts("Really? https://a.com/q?!")).toEqual(["https://a.com/q"]);
    expect(texts("wow https://a.com/x...")).toEqual(["https://a.com/x"]);
    expect(texts("and so on https://a.com/more…")).toEqual(["https://a.com/more"]);
  });

  test("strips unbalanced closing parens but keeps balanced ones", () => {
    expect(texts("(see https://a.com/x)")).toEqual(["https://a.com/x"]);
    expect(texts("(see https://a.com/x).")).toEqual(["https://a.com/x"]);
    expect(texts("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(texts("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(texts("[link](https://a.com/md)")).toEqual(["https://a.com/md"]);
    expect(texts("[https://a.com/b]")).toEqual(["https://a.com/b"]);
  });

  test("stops at quotes, angle brackets, backticks, pipes, backslashes", () => {
    expect(texts(`href="https://a.com/q" x`)).toEqual(["https://a.com/q"]);
    expect(texts(`'https://a.com/s'`)).toEqual(["https://a.com/s"]);
    expect(texts("<https://a.com/angle>")).toEqual(["https://a.com/angle"]);
    expect(texts("`https://a.com/code`")).toEqual(["https://a.com/code"]);
    expect(texts("<https://slack.com/x|the label>")).toEqual(["https://slack.com/x"]);
    expect(texts("C:\\path https://a.com/b\\c")).toEqual(["https://a.com/b"]);
  });

  test("an em or en dash ends the URL", () => {
    expect(texts("https://a.com/x—the best site")).toEqual(["https://a.com/x"]);
    expect(texts("https://a.com/y–z")).toEqual(["https://a.com/y"]);
    expect(texts("https://a.com/ok-hyphen")).toEqual(["https://a.com/ok-hyphen"]);
  });

  test("www. URLs get https://", () => {
    expect(find("visit www.example.com/path today")).toMatchObject([
      { text: "www.example.com/path", url: "https://www.example.com/path" },
    ]);
    expect(urls("WWW.Example.com.")).toEqual(["https://www.example.com/"]);
  });

  test("rejects non-URLs and URLs embedded in words/emails/paths", () => {
    expect(find("www.")).toEqual([]);
    expect(find("www.foo")).toEqual([]);
    expect(find("https://")).toEqual([]);
    expect(find("http:// nothing")).toEqual([]);
    expect(find("me@www.example.com")).toEqual([]);
    expect(find("sub.www.example.com")).toEqual([]);
    expect(find("xhttps://a.com")).toEqual([]);
    expect(find("ftp://files.example.com/x")).toEqual([]); // http(s) only
    expect(find("mailto:a@b.com javascript:alert(1)")).toEqual([]);
  });

  test("multiple URLs and unicode paths", () => {
    expect(texts("a https://ex.com/ü/ß b https://ex.com/2")).toEqual(["https://ex.com/ü/ß", "https://ex.com/2"]);
    expect(urls("https://ex.com/ü")).toEqual(["https://ex.com/%C3%BC"]);
  });

  test("is repeatable (global regex state is reset)", () => {
    expect(texts("https://a.com")).toEqual(["https://a.com"]);
    expect(texts("https://a.com")).toEqual(["https://a.com"]);
  });
});

describe("extractLinks is self-contained", () => {
  test("can be rebuilt from its source text (as executeScript does)", () => {
    const rebuilt = new Function(`return (${extractLinks.toString()})`)();
    expect(rebuilt({ textOnly: "x https://a.com/y." }).map((m) => m.text)).toEqual(["https://a.com/y"]);
    expect(extractLinks.toString().startsWith("function extractLinks")).toBe(true);
  });
});
