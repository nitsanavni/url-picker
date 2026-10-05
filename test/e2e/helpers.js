import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
export const FIXTURES = join(ROOT, "test", "fixtures");

// Static server for fixture pages on 127.0.0.1 (random port).
export function serveFixtures() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const file = Bun.file(join(FIXTURES, path === "/" ? "page.html" : path));
      if (path.endsWith(".html") && (await file.exists())) return new Response(file);
      return new Response(`<!doctype html><title>${path}</title><h1>${path}</h1>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
}
