// Photobooth server
//  - serves the booth UI (public/) to the iPad
//  - POST /api/photos   : saves a photo, returns a pickup code
//  - GET  /api/photos/:code : used by the print agent to fetch the image
//  - GET  /admin         : simple list of recent photos
import express from 'express';
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ensureCert, lanIps } from './cert.js';
import { printTicket, parseTarget } from './ticket.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- config (override with env vars) -------------------------------------
const CFG = {
  httpsPort: Number(process.env.HTTPS_PORT || 8443),
  httpPort: Number(process.env.HTTP_PORT || 8080),
  photosDir: process.env.PHOTOS_DIR || join(__dirname, 'photos'),
  // Secret the print agent must send (X-Agent-Key). Set the same value in print-agent/config.js
  agentKey: process.env.AGENT_KEY || 'change-me',
  codeLength: 6,
  // Delete photos older than this many days (0 = never)
  retentionDays: Number(process.env.RETENTION_DAYS || 0),
  // Auto-print a code slip on a printer attached to THIS computer (see ticket.js). Unset = off.
  ticketPrinter: parseTarget(process.env.TICKET_PRINTER),
};
// --------------------------------------------------------------------------

mkdirSync(CFG.photosDir, { recursive: true });

const DB_FILE = join(CFG.photosDir, 'index.json');
let db = existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, 'utf8')) : {};
function saveDb() {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Codes use letters/digits that are hard to confuse (no 0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const bytes = randomBytes(CFG.codeLength);
    let code = '';
    for (let i = 0; i < CFG.codeLength; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    if (!db[code]) return code;
  }
}

function normalizeCode(raw) {
  // alphabet has no 0/O/1/I/L, so just strip and upper-case
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function checkAgentKey(req, res, next) {
  const got = Buffer.from(String(req.get('X-Agent-Key') || ''));
  const want = Buffer.from(CFG.agentKey);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return res.status(401).json({ error: 'bad agent key' });
  }
  next();
}

const app = express();
app.disable('x-powered-by');

// ---- HTTPS bootstrap helpers (camera only works on https) --------------------
const certDir = join(__dirname, 'certs');
const tls = ensureCert(certDir, (process.env.EXTRA_HOSTS || '').split(',').filter(Boolean));
const httpsUrl = (req) => `https://${(req.hostname || lanIps()[0] || 'localhost')}:${CFG.httpsPort}`;

// Certificate download — on the iPad open http://<ip>:8080/cert, iOS offers to install it as a profile.
app.get('/cert', (_req, res) => {
  // raw setHeader + end: Express's res.set/res.send would append "; charset=utf-8", which iOS rejects
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="photobooth.crt"');
  res.end(tls.cert);
});

app.get('/setup', (req, res) => {
  const ip = req.hostname || lanIps()[0];
  res.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Photobooth setup</title>
<style>body{font:18px/1.5 -apple-system,system-ui;max-width:640px;margin:40px auto;padding:0 20px;color:#111}
ol li{margin:14px 0}a.btn{display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600}
code{background:#eee;padding:2px 6px;border-radius:4px}</style>
<h1>📸 One-time iPad setup</h1>
<p>Safari only allows the camera on a trusted <b>https://</b> page, so the iPad needs to trust this server's certificate once.</p>
<ol>
<li><a class=btn href="/cert">Download certificate</a><br><small>Tap <b>Allow</b> when Safari asks to download a configuration profile.</small></li>
<li>Open <b>Settings</b> → <b>Profile Downloaded</b> (near the top) → <b>Install</b> (enter passcode) → Install.</li>
<li>Then <b>Settings → General → About → Certificate Trust Settings</b> → turn <b>on</b> "Photobooth" under <i>Enable full trust for root certificates</i>.</li>
<li>Open the booth: <a class=btn href="https://${ip}:${CFG.httpsPort}/">https://${ip}:${CFG.httpsPort}</a><br>
<small>Add it to the Home Screen (Share → Add to Home Screen) for full-screen kiosk mode.</small></li>
</ol>
<p><small>If you skip the trust steps, Safari may show the page after "visit this website" but keep the camera blocked.</small></p>`);
});

// The booth page itself must be https — redirect plain-http visitors to setup instructions.
app.get('/', (req, res, next) => (req.secure ? next() : res.redirect('/setup')));

app.use(express.static(join(__dirname, 'public')));
app.use(express.json({ limit: '25mb' }));

// Booth uploads a JPEG as base64 data URL
app.post('/api/photos', (req, res) => {
  const { image, note } = req.body || {};
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(image || '');
  if (!m) return res.status(400).json({ error: 'expected a JPEG data URL' });

  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 1000) return res.status(400).json({ error: 'image too small' });

  const code = newCode();
  const file = `${code}.jpg`;
  writeFileSync(join(CFG.photosDir, file), buf);

  db[code] = {
    code,
    file,
    bytes: buf.length,
    note: String(note || '').slice(0, 80),
    createdAt: new Date().toISOString(),
    printedAt: null,
    prints: 0,
  };
  saveDb();

  console.log(`[photo] ${code}  ${(buf.length / 1024).toFixed(0)} KB`);
  res.json({ code, createdAt: db[code].createdAt, ticket: !!CFG.ticketPrinter });
  // print the pickup slip right away (doesn't block the booth)
  printTicket(db[code], CFG.ticketPrinter)
    .then((ok) => ok && console.log(`[ticket] ${code} printed`))
    .catch((e) => console.error(`[ticket] ${code} FAILED: ${e.message}`));
});

// Reprint a slip (admin page link, or curl)
app.post('/api/tickets/:code', async (req, res) => {
  const rec = db[normalizeCode(req.params.code)];
  if (!rec) return res.status(404).json({ error: 'no photo with that code' });
  if (!CFG.ticketPrinter) return res.status(400).json({ error: 'TICKET_PRINTER not set' });
  try { await printTicket(rec, CFG.ticketPrinter); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/admin/ticket/:code', async (req, res) => {
  const rec = db[normalizeCode(req.params.code)];
  if (!rec || !CFG.ticketPrinter) return res.status(404).send('no photo / no ticket printer');
  try { await printTicket(rec, CFG.ticketPrinter); res.redirect('/admin'); } catch (e) { res.status(500).send(e.message); }
});

// Print agent: metadata lookup
app.get('/api/photos/:code', checkAgentKey, (req, res) => {
  const rec = db[normalizeCode(req.params.code)];
  if (!rec) return res.status(404).json({ error: 'no photo with that code' });
  res.json(rec);
});

// Print agent: the image itself
app.get('/api/photos/:code/image', checkAgentKey, (req, res) => {
  const rec = db[normalizeCode(req.params.code)];
  if (!rec) return res.status(404).json({ error: 'no photo with that code' });
  res.sendFile(join(CFG.photosDir, rec.file));
});

// Print agent: mark as printed
app.post('/api/photos/:code/printed', checkAgentKey, (req, res) => {
  const rec = db[normalizeCode(req.params.code)];
  if (!rec) return res.status(404).json({ error: 'no photo with that code' });
  rec.printedAt = new Date().toISOString();
  rec.prints = (rec.prints || 0) + 1;
  saveDb();
  res.json(rec);
});

// Tiny admin page (no auth — it is LAN only; add a key check if you expose it)
app.get('/admin', (_req, res) => {
  const rows = Object.values(db)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map(
      (r) =>
        `<tr><td><b>${r.code}</b></td><td>${r.createdAt.replace('T', ' ').slice(0, 19)}</td>` +
        `<td>${r.prints || 0}</td><td>${r.note || ''}</td>` +
        `<td><a href="/admin/photo/${r.code}" target="_blank">view</a>` +
        (CFG.ticketPrinter ? ` · <a href="/admin/ticket/${r.code}">reprint slip</a>` : '') + `</td></tr>`
    )
    .join('');
  res.send(`<!doctype html><meta charset=utf-8><title>Photobooth admin</title>
<style>body{font:15px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}</style>
<h1>Photos (${Object.keys(db).length})</h1>
<table><tr><th>Code</th><th>Taken (UTC)</th><th>Prints</th><th>Note</th><th></th></tr>${rows}</table>`);
});
app.get('/admin/photo/:code', (req, res) => {
  const rec = db[normalizeCode(req.params.code)];
  if (!rec) return res.sendStatus(404);
  res.sendFile(join(CFG.photosDir, rec.file));
});

app.get('/api/health', (_req, res) => res.json({ ok: true, photos: Object.keys(db).length }));

// ---- retention -----------------------------------------------------------
if (CFG.retentionDays > 0) {
  const sweep = () => {
    const cutoff = Date.now() - CFG.retentionDays * 86400e3;
    let n = 0;
    for (const [code, rec] of Object.entries(db)) {
      if (new Date(rec.createdAt).getTime() < cutoff) {
        try { unlinkSync(join(CFG.photosDir, rec.file)); } catch {}
        delete db[code];
        n++;
      }
    }
    if (n) { saveDb(); console.log(`[retention] removed ${n} old photo(s)`); }
  };
  sweep();
  setInterval(sweep, 6 * 3600e3);
}

// ---- start ---------------------------------------------------------------
const ip = lanIps()[0] || 'localhost';

createHttps({ key: tls.key, cert: tls.cert }, app).listen(CFG.httpsPort, () => {
  console.log(`Booth (iPad):   https://${ip}:${CFG.httpsPort}`);
  console.log(`iPad setup:     http://${ip}:${CFG.httpPort}/setup   ← do this once per iPad (installs the certificate)`);
  console.log(`Admin:          https://${ip}:${CFG.httpsPort}/admin`);
  if (tls.regenerated) console.log('[cert] new certificate generated — iPads must (re)install it via /setup');
});
// Plain HTTP too (setup page, print agent, testing on the PC itself)
createHttp(app).listen(CFG.httpPort, () => {
  console.log(`HTTP (agent):   http://${ip}:${CFG.httpPort}`);
  console.log(`Photos dir:     ${CFG.photosDir}`);
  if (CFG.agentKey === 'change-me') console.warn('AGENT_KEY is still the default — set it before going live.');
  console.log(`Ticket printer: ${process.env.TICKET_PRINTER || 'off (set TICKET_PRINTER=serial:/dev/tty.PT-210 to print code slips here)'}`);
});
