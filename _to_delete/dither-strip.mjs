import { readFileSync, writeFileSync } from 'node:fs';
import { imageToBitmap, bitmapToPng, buildReceipt } from '../print-agent/escpos.js';
import config from '../print-agent/config.js';
const img = readFileSync('../_to_delete/strip-test.jpg');
const bmp = await imageToBitmap(img, { width: 576, ...config.layout });
writeFileSync('../_to_delete/strip-dithered.png', await bitmapToPng(bmp));
const { chunks } = await buildReceipt(img, { code: 'GRRR42', date: 'Oct 9, 2026', printer: config.printer, layout: config.layout });
console.log('dithered', bmp.width + 'x' + bmp.height, 'dots =', (bmp.height / 8).toFixed(0), 'mm of paper;', 'receipt bytes', chunks.reduce((a, c) => a + c.length, 0));
