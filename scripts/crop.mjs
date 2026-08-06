// Crop and scale a PNG to exact dimensions.
//
// Exists because sips can only centre-crop, and a screenshot's subject is almost
// never centred: a modal near the top of the frame gets its header sliced off.
//
//   node scripts/crop.mjs in.png out.png 1280 800 [--top|--centre|--bottom]

import { readFileSync, writeFileSync } from "node:fs";
import { decodePNG, encodePNG } from "./png.mjs";

// --- crop + scale ------------------------------------------------------------

const [input, output, targetW, targetH, anchorArg] = process.argv.slice(2);
if (!input || !output || !targetW || !targetH) {
  console.error("usage: node scripts/crop.mjs in.png out.png <width> <height> [--top|--centre|--bottom]");
  process.exit(1);
}

const tw = Number(targetW);
const th = Number(targetH);
const anchor = (anchorArg || "--centre").replace("--", "");

const src = decodePNG(readFileSync(input));

// Take the largest region of the source matching the target aspect ratio, then
// place it vertically according to the anchor.
const aspect = tw / th;
let cropW = src.width;
let cropH = Math.round(cropW / aspect);
if (cropH > src.height) {
  cropH = src.height;
  cropW = Math.round(cropH * aspect);
}
const offsetX = Math.round((src.width - cropW) / 2);
const offsetY =
  anchor === "top" ? 0 : anchor === "bottom" ? src.height - cropH : Math.round((src.height - cropH) / 2);

// Area-average downscale with fractional edge weights. The naive version — floor
// the start, ceil the end, weight every covered pixel equally — quietly softens
// text at non-integer ratios, because edge pixels only partly covered by the
// destination pixel still contribute in full.
//
// Sharpest results still come from an integer ratio: capture at exactly 2x the
// target (2560x1600 for a 1280x800 screenshot) and every output pixel is the
// average of exactly four input pixels, with no fractional coverage at all.
const dst = Buffer.alloc(tw * th * 4);
const scaleX = cropW / tw;
const scaleY = cropH / th;

for (let y = 0; y < th; y++) {
  const srcTop = offsetY + y * scaleY;
  const srcBottom = srcTop + scaleY;

  for (let x = 0; x < tw; x++) {
    const srcLeft = offsetX + x * scaleX;
    const srcRight = srcLeft + scaleX;

    let r = 0, g = 0, b = 0, a = 0, weight = 0;

    for (let sy = Math.floor(srcTop); sy < Math.ceil(srcBottom); sy++) {
      if (sy < 0 || sy >= src.height) continue;
      const wy = Math.min(sy + 1, srcBottom) - Math.max(sy, srcTop);
      if (wy <= 0) continue;

      for (let sx = Math.floor(srcLeft); sx < Math.ceil(srcRight); sx++) {
        if (sx < 0 || sx >= src.width) continue;
        const wx = Math.min(sx + 1, srcRight) - Math.max(sx, srcLeft);
        if (wx <= 0) continue;

        const w = wx * wy;
        const i = (sy * src.width + sx) * 4;
        r += src.pixels[i] * w;
        g += src.pixels[i + 1] * w;
        b += src.pixels[i + 2] * w;
        a += src.pixels[i + 3] * w;
        weight += w;
      }
    }

    const d = (y * tw + x) * 4;
    dst[d] = Math.round(r / weight);
    dst[d + 1] = Math.round(g / weight);
    dst[d + 2] = Math.round(b / weight);
    dst[d + 3] = Math.round(a / weight);
  }
}

writeFileSync(output, encodePNG(tw, th, dst));
const ratio = (cropW / tw).toFixed(3);
console.log(
  `${output}  ${tw}x${th}  (from ${src.width}x${src.height}, ${anchor} crop ${cropW}x${cropH}, ` +
    `downscale ${ratio}:1${Number(ratio) % 1 === 0 ? "" : " — an integer ratio would be sharper"})`
);
