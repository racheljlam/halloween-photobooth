// Print counter web UI: open http://localhost:3000, type the code, see preview, print.
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { lookup, preview, printCode } from './print.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

app.get('/api/lookup/:code', async (req, res) => {
  try {
    const rec = await lookup(req.params.code);
    if (!rec) return res.status(404).json({ error: 'No photo with that code' });
    res.json(rec);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/preview/:code', async (req, res) => {
  try {
    const p = await preview(req.params.code);
    if (!p) return res.status(404).send('not found');
    res.type('png').send(p.png);
  } catch (e) { res.status(502).send(e.message); }
});

app.post('/api/print/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const rec = await printCode(code);
    console.log(`[print] ${rec.code} ok`);
    res.json({ ok: true, rec });
  } catch (e) {
    console.error(`[print] ${code} FAILED: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config', (_req, res) => res.json({ server: config.serverUrl, printer: config.printer.type, width: config.printer.widthDots }));

app.listen(config.uiPort, () => {
  console.log(`Print counter UI: http://localhost:${config.uiPort}`);
  console.log(`Booth server:     ${config.serverUrl}`);
  console.log(`Printer:          ${config.printer.type} ${config.printer.type === 'tcp' ? config.printer.host + ':' + config.printer.port : ''}`);
});
