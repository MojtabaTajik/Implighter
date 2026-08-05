// Renders the icon set from geometry. Zero dependencies — Node's zlib does the
// PNG compression — so it stays consistent with the repo's no-build policy and
// the icons can be re-tuned without another design round trip.
//
// Chrome has no theme-adaptive extension icons: one asset must read on both a
// light and a dark toolbar. A near-black tile vanishes into a dark toolbar, so
// the tile and the muted bars are lifted well clear of both extremes.
//
//   node scripts/make-icons.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const TILE = [0x2b, 0x30, 0x3a]; // lifted off pure black so it separates on a dark toolbar
const MUTED = [0x79, 0x83, 0x93]; // the dimmed lines
const ACCENT = [0xf0, 0xb4, 0x29]; // the highlighted line
const SS = 4; // supersample factor, for antialiased edges without a graphics lib

// Geometry in a 128-unit design space, scaled per output size.
const UNIT = 128;
const CORNER = 28;
const BARS = [
  { w: 46, h: 11, color: MUTED },
  { w: 74, h: 15, color: ACCENT },
  { w: 46, h: 11, color: MUTED }
];
const GAP = 11;
const BAR_X = 27;

function insideRoundedRect(x, y, left, top, w, h, r) {
  const right = left + w;
  const bottom = top + h;
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function render(size) {
  const scale = size / UNIT;
  const pixels = Buffer.alloc(size * size * 4);

  const totalHeight = BARS.reduce((sum, b) => sum + b.h, 0) + GAP * (BARS.length - 1);
  let barTop = (UNIT - totalHeight) / 2;
  const placed = BARS.map((bar) => {
    const entry = { ...bar, top: barTop };
    barTop += bar.h + GAP;
    return entry;
  });

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // Supersample: average SS*SS sample points per pixel.
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / scale);
          const y = ((py + (sy + 0.5) / SS) / scale);

          let color = null;
          if (insideRoundedRect(x, y, 0, 0, UNIT, UNIT, CORNER)) {
            color = TILE;
            for (const bar of placed) {
              if (insideRoundedRect(x, y, BAR_X, bar.top, bar.w, bar.h, bar.h / 2)) {
                color = bar.color;
                break;
              }
            }
          }

          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }

      const samples = SS * SS;
      const i = (py * size + px) * 4;
      // Premultiplied average would darken edges against light backgrounds, so
      // colour is averaged over covered samples only and alpha carries coverage.
      const covered = a / 255;
      pixels[i] = covered ? Math.round(r / covered) : 0;
      pixels[i + 1] = covered ? Math.round(g / covered) : 0;
      pixels[i + 2] = covered ? Math.round(b / covered) : 0;
      pixels[i + 3] = Math.round(a / samples);
    }
  }

  return pixels;
}

// --- Minimal PNG encoder -----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

mkdirSync("icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = `icons/icon${size}.png`;
  writeFileSync(file, encodePNG(size, render(size)));
  console.log(`wrote ${file} (${size}x${size})`);
}
