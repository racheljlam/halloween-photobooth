// Ticket printer: prints a small "room key" slip (code only, no photo) the moment a strip is saved.
// Meant for a portable 58 mm Bluetooth printer (GOOJPRT PT-210 etc.) paired with this computer.
//
// TICKET_PRINTER env var picks the transport:
//   serial:/dev/tty.PT-210        macOS/Linux Bluetooth SPP or USB serial device
//   tcp:192.168.1.50:9100         network printer
//   ble:PT210_8C73                Bluetooth LE via ble_print.py (needs: python3 -m pip install --user bleak)
//   cups:PT210                    USB printer added as a raw queue (macOS/Linux, via `lp -o raw`)
//   file:./ticket.bin             debugging
//   (unset)                       tickets off
//
// Test:  TICKET_PRINTER=serial:/dev/tty.PT-210 node ticket.js --test
import { openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import net from 'node:net';

const ESC = 0x1b, GS = 0x1d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (s) => Buffer.from(s + '\n', 'ascii');
const size = (w, h) => Buffer.from([GS, 0x21, ((w - 1) << 4) | (h - 1)]);
const bold = (on) => Buffer.from([ESC, 0x45, on ? 1 : 0]);

export const TICKET = {
  title: ['HOTEL', 'TRANSYLVANIA'],
  heading: 'Your room key',
  lines: ['Show this at the front desk', 'to get your photo strip'],
  footer: 'MORE Power Halloween 2026',
  credit: 'brought to you by < IT />',
  feedLines: 4,            // portable printers have no cutter; feed so the slip can be torn
  chunkBytes: 256,         // Bluetooth SPP drops bytes if flooded
  chunkDelayMs: 25,
  drainMs: 1500,           // keep the Bluetooth link open this long after the last byte
};

export function buildTicket({ code, createdAt, note }) {
  const when = new Date(createdAt || Date.now()).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  const out = [
    Buffer.from([ESC, 0x40]),          // init
    Buffer.from([ESC, 0x61, 1]),       // center
    bold(true), size(2, 2), ...TICKET.title.map(t), size(1, 1), bold(false),
    t(''),
    t(TICKET.heading),
    t(''),
    bold(true), size(3, 3), t(code), size(1, 1), bold(false),
    t(''),
    ...TICKET.lines.map(t),
  ];
  const m = /rawr (\d+)% \((.+)\)/.exec(note || '');
  if (m) out.push(t(''), bold(true), t(`ROAR POWER ${m[1]}%`), t(m[2].toUpperCase()), bold(false));
  out.push(t(''), t(when), t(TICKET.footer), t(TICKET.credit), Buffer.from([ESC, 0x64, TICKET.feedLines]));
  return Buffer.concat(out);
}

export function parseTarget(spec) {
  if (!spec) return null;
  const [type, ...rest] = spec.split(':');
  const arg = rest.join(':');
  if (type === 'serial') return { type, path: arg };
  if (type === 'tcp') { const [host, port] = arg.split(':'); return { type, host, port: Number(port || 9100) }; }
  if (type === 'file') return { type, path: arg || './ticket.bin' };
  if (type === 'cups') return { type, queue: arg };
  if (type === 'ble') return { type, name: arg };
  throw new Error(`TICKET_PRINTER: unknown type "${type}" (use serial:, tcp:, cups: or file:)`);
}

let serialBusy = Promise.resolve();
async function sendSerial(bytes, path) {
  // one job at a time on the port
  const job = serialBusy.then(async () => {
    try { execFileSync('stty', ['-f', path, 'raw', '-echo'], { stdio: 'ignore' }); } catch { /* not a tty (e.g. Linux /dev/usb/lp0) */ }
    // Bluetooth SPP: the link comes up when the port is opened and bytes are still in flight after
    // the last write — closing too early silently drops the tail (or the whole slip). Open with the
    // non-blocking flag (tty.* otherwise waits for a carrier that BT never asserts) and drain before close.
    const fd = openSync(path, 'r+');
    try {
      for (let i = 0; i < bytes.length; i += TICKET.chunkBytes) {
        writeSync(fd, bytes.subarray(i, i + TICKET.chunkBytes));
        await sleep(TICKET.chunkDelayMs);
      }
      await sleep(TICKET.drainMs);
    } finally { closeSync(fd); }
  });
  serialBusy = job.catch(() => {});
  return job;
}

function sendTcp(bytes, { host, port }) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port });
    s.setTimeout(10000);
    s.once('error', reject); s.once('timeout', () => reject(new Error('printer timeout')));
    s.once('connect', () => s.end(bytes, resolve));
  });
}

// Raw job through CUPS (macOS / Linux). Queue must be a raw queue: lpadmin -p PT210 -E -v usb://... -m raw
function sendCups(bytes, { queue }) {
  const f = join(tmpdir(), `ticket-${Date.now()}.bin`);
  writeFileSync(f, bytes);
  execFileSync('lp', ['-d', queue, '-o', 'raw', f], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// Bluetooth LE through the Python helper (serial jobs on this transport are queued one at a time)
let bleBusy = Promise.resolve();
function sendBle(bytes, { name }) {
  const f = join(tmpdir(), `ticket-${Date.now()}.bin`);
  writeFileSync(f, bytes);
  const job = bleBusy.then(() => {
    const out = execFileSync(process.env.PYTHON || 'python3', [join(__dirname, 'ble_print.py'), name, f], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000 });
    console.log('[ticket] ' + out.toString().trim());
  });
  bleBusy = job.catch(() => {});
  return job;
}

export async function printTicket(rec, target) {
  if (!target) return false;
  const bytes = buildTicket(rec);
  if (target.type === 'serial') await sendSerial(bytes, target.path);
  else if (target.type === 'tcp') await sendTcp(bytes, target);
  else if (target.type === 'cups') sendCups(bytes, target);
  else if (target.type === 'ble') await sendBle(bytes, target);
  else writeFileSync(target.path, bytes);
  return true;
}

// CLI test
if (process.argv[1] && process.argv[1].endsWith('ticket.js')) {
  const target = parseTarget(process.env.TICKET_PRINTER);
  if (!target) { console.error('Set TICKET_PRINTER, e.g. TICKET_PRINTER=serial:/dev/tty.PT-210 node ticket.js --test'); process.exit(1); }
  const code = process.argv[2] && process.argv[2] !== '--test' ? process.argv[2] : 'TEST42';
  printTicket({ code, createdAt: new Date().toISOString(), note: 'rawr 88% (a mighty roar)' }, target)
    .then(() => console.log(`Ticket ${code} sent to ${process.env.TICKET_PRINTER}`))
    .catch((e) => { console.error('Ticket failed:', e.message); process.exit(1); });
}
