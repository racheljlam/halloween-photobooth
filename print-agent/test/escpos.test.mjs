// Unit test for the pure parts of escpos.js (no sharp needed). Run: node test/escpos.test.mjs
import { strict as assert } from 'node:assert';

const { ditherGray, packBits, bitmapToRaster, cmd } = await import('../escpos.js');

// gradient 64x8: left black, right white
const w = 64, h = 8;
const gray = new Uint8Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = Math.round((x / (w - 1)) * 255);

for (const mode of ['threshold', 'floyd', 'atkinson']) {
  const bits = ditherGray(gray, w, h, mode);
  assert.equal(bits.length, w * h);
  // black density should decrease left → right
  const left = bits.slice(0, 16).reduce((a, b) => a + b, 0) + bits.slice(w, w + 16).reduce((a, b) => a + b, 0);
  const right = bits.slice(w - 16, w).reduce((a, b) => a + b, 0) + bits.slice(2 * w - 16, 2 * w).reduce((a, b) => a + b, 0);
  assert.ok(left > right, `${mode}: left (${left}) should be darker than right (${right})`);
  // error diffusion should produce some mid-gray texture that threshold does not
  if (mode !== 'threshold') {
    const mid = bits.slice(24, 40).reduce((a, b) => a + b, 0);
    assert.ok(mid > 0 && mid < 16, `${mode}: middle should be textured, got ${mid}/16 black`);
  }
  console.log(`dither ${mode.padEnd(9)} ok  (row 0: ${Array.from(bits.slice(0, w)).join('')})`);
}

// packBits: MSB = leftmost
const bits = new Uint8Array(16); bits[0] = 1; bits[7] = 1; bits[8] = 1; bits[15] = 1;
const bmp = packBits(bits, 16, 1);
assert.equal(bmp.bytesPerRow, 2);
assert.deepEqual([...bmp.data], [0b10000001, 0b10000001]);
console.log('packBits ok');

// raster framing: GS v 0 m xL xH yL yH + data, strips of N rows
const tall = packBits(new Uint8Array(576 * 300), 576, 300);
const chunks = bitmapToRaster(tall, 128);
assert.equal(chunks.length, 3); // 128 + 128 + 44
assert.deepEqual([...chunks[0].subarray(0, 8)], [0x1d, 0x76, 0x30, 0, 72, 0, 128, 0]);
assert.deepEqual([...chunks[2].subarray(0, 8)], [0x1d, 0x76, 0x30, 0, 72, 0, 44, 0]);
assert.equal(chunks[0].length, 8 + 72 * 128);
console.log('raster framing ok');

assert.deepEqual([...cmd.size(2, 2)], [0x1d, 0x21, 0x11]);
assert.deepEqual([...cmd.cut], [0x1d, 0x56, 66, 0]);
console.log('commands ok');
console.log('\nALL TESTS PASSED');
