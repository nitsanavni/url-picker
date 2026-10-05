// Generates icons/icon{16,32,48,128}.png with no dependencies (zlib only).
// Design: rounded square, three list rows, the top one highlighted + a ">" caret.
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const SS = 4; // supersampling per axis

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// Distance from point to segment, for the caret strokes.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Shape in unit coords (0..1). Returns [r,g,b,a] or null.
function shade(u, v) {
  const BG = [37, 99, 235], WHITE = [255, 255, 255], DIM = [191, 210, 250];
  if (!inRoundRect(u, v, 0.03, 0.03, 0.97, 0.97, 0.2)) return null;
  // caret ">" on the first row
  if (segDist(u, v, 0.17, 0.22, 0.29, 0.31) < 0.055 || segDist(u, v, 0.29, 0.31, 0.17, 0.40) < 0.055) return WHITE;
  if (inRoundRect(u, v, 0.38, 0.25, 0.84, 0.37, 0.06)) return WHITE;
  if (inRoundRect(u, v, 0.38, 0.46, 0.80, 0.56, 0.05)) return DIM;
  if (inRoundRect(u, v, 0.38, 0.65, 0.72, 0.75, 0.05)) return DIM;
  return BG;
}

for (const size of [16, 32, 48, 128]) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round((255 * a) / (SS * SS));
      }
    }
  }
  const out = join(import.meta.dir, "..", "icons", `icon${size}.png`);
  await Bun.write(out, png(size, rgba));
  console.log("wrote", out);
}
