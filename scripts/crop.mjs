// Crop and scale a PNG to exact dimensions. Zero dependencies — Node's zlib does
// the codec work — matching the rest of the repo's no-build policy.
//
// Exists because sips can only centre-crop, and a screenshot's subject is almost
// never centred: a modal near the top of the frame gets its header sliced off.
//
//   node scripts/crop.mjs in.png out.png 1280 800 [--top|--centre|--bottom]

import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

// --- decode ------------------------------------------------------------------

function decodePNG(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");

  let pos = 8;
  let width, height, depth, colorType;
  const idat = [];

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (depth !== 8) throw new Error(`Unsupported bit depth ${depth}`);
      if (![2, 6].includes(colorType)) throw new Error(`Unsupported colour type ${colorType}`);
      if (data[12] !== 0) throw new Error("Interlaced PNGs are not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;

    pos += 12 + length;
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);

  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    raw.copy(line, 0, read, read + stride);
    read += stride;

    // Undo the per-scanline filter. Byte-wise, referencing the pixel to the left
    // (a), the one above (b), and above-left (c), per the PNG spec.
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    line.copy(prev);
  }

  return { width, height, pixels: out };
}

// --- encode ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

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

// Box-filter downscale: averaging the source pixels covered by each destination
// pixel, which keeps small text legible where nearest-neighbour would not.
const dst = Buffer.alloc(tw * th * 4);
const scaleX = cropW / tw;
const scaleY = cropH / th;

for (let y = 0; y < th; y++) {
  const y0 = offsetY + Math.floor(y * scaleY);
  const y1 = Math.min(offsetY + cropH, offsetY + Math.ceil((y + 1) * scaleY));
  for (let x = 0; x < tw; x++) {
    const x0 = offsetX + Math.floor(x * scaleX);
    const x1 = Math.min(offsetX + cropW, offsetX + Math.ceil((x + 1) * scaleX));

    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const i = (sy * src.width + sx) * 4;
        r += src.pixels[i]; g += src.pixels[i + 1]; b += src.pixels[i + 2]; a += src.pixels[i + 3];
        n++;
      }
    }
    const d = (y * tw + x) * 4;
    dst[d] = Math.round(r / n);
    dst[d + 1] = Math.round(g / n);
    dst[d + 2] = Math.round(b / n);
    dst[d + 3] = Math.round(a / n);
  }
}

writeFileSync(output, encodePNG(tw, th, dst));
console.log(`${output}  ${tw}x${th}  (from ${src.width}x${src.height}, ${anchor}-anchored crop ${cropW}x${cropH})`);
