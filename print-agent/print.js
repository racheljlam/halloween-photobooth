// Shared print logic used by both the web UI (agent.js) and the CLI (cli.js)
import config from './config.js';
import { buildReceipt, bitmapToPng, imageToBitmap } from './escpos.js';
import { send } from './transport.js';

const headers = { 'X-Agent-Key': config.agentKey };

export async function lookup(code) {
  const r = await fetch(`${config.serverUrl}/api/photos/${encodeURIComponent(code)}`, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`server ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function fetchImage(code) {
  const r = await fetch(`${config.serverUrl}/api/photos/${encodeURIComponent(code)}/image`, { headers });
  if (!r.ok) throw new Error(`server ${r.status} fetching image`);
  return Buffer.from(await r.arrayBuffer());
}

export async function markPrinted(code) {
  await fetch(`${config.serverUrl}/api/photos/${encodeURIComponent(code)}/printed`, { method: 'POST', headers }).catch(() => {});
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Dithered PNG preview of what will be printed. */
export async function preview(code) {
  const rec = await lookup(code);
  if (!rec) return null;
  const img = await fetchImage(code);
  const bmp = await imageToBitmap(img, { width: config.printer.widthDots, ...config.layout });
  return { rec, png: await bitmapToPng(bmp) };
}

/** Fetch + print. Returns the record. */
export async function printCode(code, { imageOverride } = {}) {
  const rec = imageOverride ? { code, createdAt: new Date().toISOString() } : await lookup(code);
  if (!rec) throw new Error('No photo with that code');
  const img = imageOverride || (await fetchImage(code));
  const { chunks } = await buildReceipt(img, {
    code: rec.code, date: fmtDate(rec.createdAt), printer: config.printer, layout: config.layout,
  });
  await send(chunks, config.printer);
  if (!imageOverride) await markPrinted(code);
  return rec;
}
