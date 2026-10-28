// Image → 1-bit raster → ESC/POS bytes
//
// Image decoding/resizing uses `sharp` (fast, native) when it loads, and falls back to
// pure-JS `jpeg-js` + `pngjs` otherwise (slower but works anywhere Node runs).
let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* fall back below */ }
export const backend = sharp ? 'sharp' : 'jpeg-js';

const ESC = 0x1b, GS = 0x1d;

export const cmd = {
  init: Buffer.from([ESC, 0x40]),
  alignLeft: Buffer.from([ESC, 0x61, 0]),
  alignCenter: Buffer.from([ESC, 0x61, 1]),
  bold: (on) => Buffer.from([ESC, 0x45, on ? 1 : 0]),
  // width/height multipliers 1..8
  size: (w, h) => Buffer.from([GS, 0x21, ((w - 1) << 4) | (h - 1)]),
  feed: (n) => Buffer.from([ESC, 0x64, n]),
  cut: Buffer.from([GS, 0x56, 66, 0]), // partial cut with feed
  heat: (dots, time, interval) => Buffer.from([ESC, 0x37, dots & 0xff, time & 0xff, interval & 0xff]), // ESC 7 print density
  text: (s) => Buffer.from(s + '\n', 'ascii'),
  // GS v 0 raster bit image, mode 0 (normal)
  rasterHeader: (bytesPerRow, rows) =>
    Buffer.from([GS, 0x76, 0x30, 0, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]),
};

/**
 * Dither an 8-bit grayscale buffer (row-major, 0=black..255=white) to 1-bit.
 * Returns Uint8Array of w*h with 1 = black. Pure function, no deps.
 */
export function ditherGray(src, w, h, dither = 'atkinson') {
  const gray = Float32Array.from(src);
  const bits = new Uint8Array(w * h);
  if (dither === 'threshold') {
    for (let i = 0; i < w * h; i++) bits[i] = gray[i] < 128 ? 1 : 0;
  } else if (dither === 'floyd') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, old = gray[i], nw = old < 128 ? 0 : 255;
      bits[i] = nw === 0 ? 1 : 0;
      const err = old - nw;
      if (x + 1 < w) gray[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += err * 3 / 16;
        gray[i + w] += err * 5 / 16;
        if (x + 1 < w) gray[i + w + 1] += err * 1 / 16;
      }
    }
  } else { // atkinson
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, old = gray[i], nw = old < 128 ? 0 : 255;
      bits[i] = nw === 0 ? 1 : 0;
      const e = (old - nw) / 8;
      if (x + 1 < w) gray[i + 1] += e;
      if (x + 2 < w) gray[i + 2] += e;
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += e;
        gray[i + w] += e;
        if (x + 1 < w) gray[i + w + 1] += e;
      }
      if (y + 2 < h) gray[i + 2 * w] += e;
    }
  }
  return bits;
}

/** Pack 1-bit pixels (1 = black) into bytes, MSB = leftmost. w must be a multiple of 8. */
export function packBits(bits, w, h) {
  const bytesPerRow = w / 8;
  const packed = Buffer.alloc(bytesPerRow * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (bits[y * w + x]) packed[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return { width: w, height: h, bytesPerRow, data: packed };
}

/** Decode + resize + grayscale + tone adjust. Returns { gray: Uint8Array, w, h }. */
async function toGray(input, { width, brightness, contrast, gamma }) {
  if (sharp) {
    let img = sharp(input).rotate().resize({ width, withoutEnlargement: false }).grayscale();
    if (brightness !== 1) img = img.modulate({ brightness });
    if (contrast !== 1) img = img.linear(contrast, 128 * (1 - contrast));
    if (gamma !== 1) img = img.gamma(Math.max(1, Math.min(3, gamma)));
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const gray = new Uint8Array(info.width * info.height);
    for (let i = 0; i < gray.length; i++) gray[i] = data[i * info.channels];
    return { gray, w: info.width, h: info.height };
  }

  // ---- pure-JS fallback ----
  const { decode } = await import('jpeg-js');
  const src = decode(input, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  const sw = src.width, sh = src.height, w = width, h = Math.round((sh * w) / sw);
  // box-filter downscale (area average) → grayscale
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * sh) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * sw) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / w));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * sw + xx) * 4;
        sum += 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2]; n++;
      }
      let v = sum / n;
      v *= brightness;
      v = contrast * v + 128 * (1 - contrast);
      if (gamma !== 1) v = 255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, 1 / gamma);
      gray[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { gray, w, h };
}

/**
 * Convert an image buffer (jpeg; png too when sharp is available) to a packed 1-bit bitmap at `width` dots wide.
 * Returns { width, height, bytesPerRow, data } where data is row-major, MSB = leftmost pixel, 1 = black.
 */
export async function imageToBitmap(input, { width, dither = 'atkinson', brightness = 1, contrast = 1, gamma = 1 } = {}) {
  width = width & ~7; // multiple of 8
  const { gray, w, h } = await toGray(input, { width, brightness, contrast, gamma });
  return packBits(ditherGray(gray, w, h, dither), w, h);
}

/** Bitmap → list of ESC/POS raster commands, split into strips. */
export function bitmapToRaster(bmp, stripRows = 128) {
  const chunks = [];
  for (let y0 = 0; y0 < bmp.height; y0 += stripRows) {
    const rows = Math.min(stripRows, bmp.height - y0);
    chunks.push(Buffer.concat([
      cmd.rasterHeader(bmp.bytesPerRow, rows),
      bmp.data.subarray(y0 * bmp.bytesPerRow, (y0 + rows) * bmp.bytesPerRow),
    ]));
  }
  return chunks;
}

/** PNG preview of the dithered bitmap (what the paper will look like). */
export async function bitmapToPng(bmp) {
  const px = Buffer.alloc(bmp.width * bmp.height);
  for (let y = 0; y < bmp.height; y++) for (let x = 0; x < bmp.width; x++) {
    px[y * bmp.width + x] = (bmp.data[y * bmp.bytesPerRow + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
  }
  if (sharp) return sharp(px, { raw: { width: bmp.width, height: bmp.height, channels: 1 } }).png().toBuffer();
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: bmp.width, height: bmp.height });
  for (let i = 0; i < px.length; i++) { png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = px[i]; png.data[i * 4 + 3] = 255; }
  return PNG.sync.write(png);
}

/** Synthetic test image (gradient + circle + text-ish bars) as JPEG, for `cli.js --test`. */
export async function testPatternJpeg() {
  const w = 600, h = 400;
  if (sharp) {
    const svg = `<svg width="${w}" height="${h}"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="300" cy="200" r="120" fill="#888"/>
      <text x="300" y="215" font-size="48" text-anchor="middle" fill="#fff" font-family="sans-serif">TEST</text></svg>`;
    return sharp(Buffer.from(svg)).jpeg().toBuffer();
  }
  const { encode } = await import('jpeg-js');
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = Math.round((x / (w - 1)) * 255);
    const dx = x - 300, dy = y - 200;
    if (dx * dx + dy * dy < 120 * 120) v = 136;
    if (y > 180 && y < 220 && ((x >> 4) & 1)) v = 255; // striped bar in the middle
    const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return encode({ data, width: w, height: h }, 90).data;
}

/**
 * Build the full receipt: header, photo, code, footer, cut.
 * Returns an array of Buffers (so the transport can pace them).
 */
export async function buildReceipt(imageBuf, { code, date, printer, layout }) {
  const bmp = await imageToBitmap(imageBuf, {
    width: printer.widthDots,
    dither: layout.dither, brightness: layout.brightness, contrast: layout.contrast, gamma: layout.gamma,
  });

  const out = [cmd.init, cmd.alignCenter];
  if (Array.isArray(printer.heat) && printer.heat.length === 3) out.push(cmd.heat(...printer.heat));
  if (layout.header) out.push(cmd.bold(true), cmd.size(2, 2), cmd.text(layout.header), cmd.size(1, 1), cmd.bold(false), cmd.feed(1));
  out.push(...bitmapToRaster(bmp, printer.stripRows));
  out.push(cmd.feed(1));
  if (layout.printCode && code) out.push(cmd.bold(true), cmd.size(2, 2), cmd.text(code), cmd.size(1, 1), cmd.bold(false));
  if (layout.printDate && date) out.push(cmd.text(date));
  if (layout.footer) out.push(cmd.feed(1), cmd.text(layout.footer));
  out.push(cmd.feed(printer.feedLines || 4));
  if (printer.cut) out.push(cmd.cut);
  return { chunks: out, bitmap: bmp };
}
