# URL Picker

A Chrome extension (Manifest V3) for opening links from the keyboard. Press **Control+U** to get an fzf-style picker with the current page's links and plain-text URLs. Type to filter, Tab to multi-select, and Enter to open them as background tabs right after the current tab.

![icon](icons/icon48.png)

## What it does

- Lists every `http(s)` link on the page (`<a href>`, `<area href>`) plus URLs written as plain text (`https://…`, `www.…`), with duplicates removed.
- The list is sorted so the links you can see come first, and prominent links come before small ones (see [Ranking](#ranking)).
- Typing filters right away using [fzf-for-js](https://github.com/ajitid/fzf-for-js), the same algorithm and extended syntax as fzf, over each link's label and URL.
- Each row shows the label with matches highlighted and the URL below it, muted. Links without text are labelled from the image alt, image title, `aria-labelledby`, the enclosing figure's caption or the link title, and as a last resort a readable form of the URL (last path segment, decoded, or the host). Badges mark links that are **off-screen**, **hidden**, or found as plain **text**.

### Keys

| Key | Action |
| --- | --- |
| type | filter (fzf extended syntax, smart case) |
| `↑` / `↓`, `Ctrl+P` / `Ctrl+N` | move the highlight |
| `PageUp` / `PageDown` | move by 10 |
| `Tab` | select/unselect the highlighted item and move down |
| `Shift+Tab` | select/unselect and move up |
| `Enter` | open the selected items (in the order you selected them), or the highlighted item if nothing is selected, as background tabs right after the current tab |
| `Ctrl+Y` | copy the selected URLs (or the highlighted one), one per line. The popup stays open and shows "copied N" |
| `⌘C` / `Ctrl+C` | same as `Ctrl+Y`, unless you have text selected in the filter box (then it copies that text as usual) |
| `Esc` | close |
| click | open that row |

Selection is keyed by URL, so it survives filter changes. You can select something, change the query, select more, and press Enter.

Filter syntax (from fzf): `foo bar` matches items containing both terms, `'exact` matches a contiguous string, `^Home` anchors to the start of the label, `.pdf$` anchors to the end of the URL, `!ads` excludes, and `docs | api` is OR. A query in all lowercase is case-insensitive; once it contains an uppercase letter it becomes case-sensitive.

## Install

1. `git clone https://github.com/nitsanavni/url-picker`
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

There is no build step. The extension is plain ES modules, and fzf-for-js is vendored in `vendor/`.

## Shortcut notes

- The manifest suggests `MacCtrl+U` on macOS (the physical Control key, not ⌘) and `Ctrl+U` everywhere else. The shortcut is bound to `_execute_action`, so it opens the popup.
- **macOS:** verified. With the extension loaded in Chromium 153, `chrome.commands.getAll()` reports `_execute_action` bound to `⌃U`. ⌃U doesn't conflict with any Chrome shortcut on macOS (View Source there is ⌥⌘U).
- **Windows/Linux:** `Ctrl+U` is Chrome's *View Source* shortcut. Chrome's docs only say that "certain operating system and Chrome shortcuts … always take priority over extension command shortcuts" and don't list which ones. **I have not verified** whether the extension wins over View Source on Windows/Linux, because all testing was done on macOS. If Ctrl+U still opens View Source, or the shortcut shows as unset, assign one yourself at `chrome://extensions/shortcuts`.
- Chrome only applies a suggested key on first install, and only if no other extension already uses it. You can change it at any time at `chrome://extensions/shortcuts`.

## Ranking

With an empty query, links are sorted by page rank (pure functions in `src/rank.js`):

1. **Tier**, which overrides everything below it:
   1. in viewport: visible and intersecting the viewport
   2. visible but off-screen
   3. hidden: `display:none`, `visibility:hidden`, `opacity:0`, zero-size or `sr-only`-style 1×1
2. **In the viewport:** sorted by prominence bucket (higher first), then reading order (top, then left).
3. **Off-screen:** sorted by distance band (each band is half a viewport height, nearer first), then prominence bucket, then exact distance.
4. **Hidden:** document order.

**Prominence** is the sum of the following weights:

| feature | weight |
| --- | --- |
| font size | `(px − 16) / 4`, clamped to [−1, +3] |
| bold (`font-weight ≥ 600`) | +0.5 |
| in or containing a heading | h1 +3, h2 +2.5, h3 +2, h4 +1.5, h5 +1, h6 +0.5 |
| rendered area | `log2(1 + px² / 2000)`, clamped to [0, +3]. Only for links with real label text: a link whose label had to be derived from its URL (e.g. an image with no alt) gets no area bonus |
| region | `main`/`article` +1.5, `nav`/`header`/`footer`/`aside` (or ARIA role equivalents) −2 |
| image link with alt text | +0.5 |

Bucket = `floor(prominence / 2)`. The buckets are coarse on purpose: a slightly bolder link doesn't jump ahead of reading order, but a headline or a big card does, and nav or footer links sink.

**Duplicates** (same URL; only a bare trailing `#` is dropped, real fragments are kept) are merged into one item. The merged item takes its position from the best occurrence (best tier, then most prominent) and uses the most informative label, i.e. real link text rather than a bare URL.

**With a query**, fzf's score decides the order. When scores tie, page rank breaks the tie: items are passed to fzf already in page-rank order, and there is also an explicit page-rank tiebreaker. So among equally good matches, visible and prominent links come first.

## Privacy and permissions

- Permissions: `activeTab` and `scripting`. There are no host permissions and no content scripts.
- The extension can read a page only after you invoke it on that tab. It then runs one function in the page that collects the links and returns them to the popup.
- Nothing is stored, and nothing leaves your browser. There is no network access and no analytics.
- Chrome doesn't allow extensions on `chrome://` pages, the Chrome Web Store or the built-in PDF viewer. On those pages the popup says "Can't read this page".

## Development

```sh
bun install
bun run test       # unit tests (fzf wrapper, ranking, picker state, plain-text URL regex)
bun run test:e2e   # extraction against real Chromium layout + the extension end to end
bun run test:all   # both
bun run icons      # regenerate icons/*.png (dependency-free PNG writer)
```

The e2e tests use Playwright's Chromium. If it isn't installed, run `bunx playwright install chromium`. Set `HEADED=1` to watch the browser.

### Layout

```
manifest.json         MV3 manifest (activeTab + scripting, Ctrl+U / MacCtrl+U)
popup.html/css/js     thin DOM layer: renders state, runs effects (open tabs, copy, close)
src/extract.js        extractLinks(): self-contained, injected via chrome.scripting.executeScript
src/rank.js           prominence score, tiers, dedupe/merge, page-rank sort
src/match.js          fzf-for-js wrapper: label+URL haystack, positions, page-rank tiebreak
src/state.js          picker reducer + key-to-command mapping
vendor/fzf.es.js      fzf-for-js 0.5.2 (BSD-3-Clause, see vendor/fzf.LICENSE.txt)
test/unit/            bun tests for the pure modules
test/e2e/             Playwright: extraction on fixtures, extension end to end
test/fixtures/        fixture pages
scripts/make-icons.js icon generator
```

### How the end-to-end test gets page access

Playwright can't click the toolbar button, so `activeTab` is never granted. The e2e test handles this in two ways:

- **It opens the popup as a normal tab** at `chrome-extension://<id>/popup.html?tabId=N`. The `tabId` parameter only tells the popup which tab to read. Without it, the popup uses the active tab, as it does in normal use. The parameter grants no access by itself.
- **It loads a test-only copy of the extension**, built in a temp directory. That copy's manifest adds:
  - `host_permissions: ["http://127.0.0.1/*"]`, which stands in for `activeTab` on the fixture server
  - `tabs`, so the test can find tabs by URL
  - `clipboardRead`, so the test can check what was copied
  - a no-op background service worker, used to get the extension id and to call `chrome.tabs.*`

  The shipped `manifest.json` is never modified.

I chose this over `optional_host_permissions` because granting optional permissions needs a user-gesture prompt that Playwright can't accept, and it would add an install-time surface the real extension doesn't need.

## Third-party

fzf-for-js © Ajit (BSD-3-Clause), vendored unmodified at `vendor/fzf.es.js`; license in `vendor/fzf.LICENSE.txt`.
