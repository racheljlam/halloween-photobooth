# Photo Booth → Thermal Print

Two small Node.js apps:

```
iPad (Safari)  ──Wi-Fi──▶  server/   (your PC: booth UI, saves photos, hands out pickup codes)
                                │
                                │ LAN, HTTP + shared key
                                ▼
                          print-agent/  (print-counter PC: type code → preview → ESC/POS thermal printer)
```

Guest takes a photo on the iPad → gets a 6-character code (e.g. `K7MQ2X`) → gives it to the counter →
staff types the code, sees a dithered preview, hits Print → receipt printer prints the photo + code.

Requires Node.js 18+ on both PCs (<https://nodejs.org>). Both apps are plain JS, no build step.

---

## 1. Booth server (PC #1)

```bash
cd server
npm install
set AGENT_KEY=some-long-secret     # Windows cmd   (PowerShell: $env:AGENT_KEY="some-long-secret", macOS/Linux: export AGENT_KEY=...)
npm start
```

A self-signed HTTPS certificate is generated automatically on first start (and regenerated if the PC's
LAN IP changes). It prints the URLs:

```
Booth (iPad):   https://192.168.1.10:8443
iPad setup:     http://192.168.1.10:8080/setup   ← do this once per iPad (installs the certificate)
Admin:          https://192.168.1.10:8443/admin
HTTP (agent):   http://192.168.1.10:8080
```

**On the iPad (once):** Safari only enables the camera on a *trusted* https page, so open the
`http://…:8080/setup` link in Safari and follow the 3 steps — download the certificate, install the profile
in Settings, then enable full trust under *Settings → General → About → Certificate Trust Settings*.
After that open `https://…:8443` in Safari and allow the camera. For kiosk use, keep it in Safari (not
"Add to Home Screen" — iOS web-app mode has camera bugs) and turn on *Guided Access* (Settings → Accessibility,
then triple-click the top button) so guests can't leave the page.

**Camera preview is black but no error?** iOS only lets one page use the camera at a time — close every other
Safari tab (and any app using the camera), then tap *Flip* to reopen it. The small gray diagnostic line at the
top-right of the booth shows the camera state (`MUTED` = something else holds the camera; `paused` = autoplay
blocked, e.g. Low Power Mode — a *Tap to start camera* button appears for that).

If the booth page says the camera is blocked, it is always one of: opened over `http://` instead of
`https://`, certificate not trusted yet, or camera denied in Safari's *aA → Website Settings*.

Photos land in `server/photos/<CODE>.jpg`, with `server/photos/index.json` as the lookup table.

`npm run dev` instead of `npm start` restarts the server automatically when you edit a file (Node's built-in
`--watch`; the booth page itself is static — just reload it on the iPad). Same for the print agent.

Options (env vars): `HTTPS_PORT` (8443), `HTTP_PORT` (8080), `PHOTOS_DIR`, `AGENT_KEY`, `RETENTION_DAYS` (0 = keep forever).

Windows Firewall will ask to allow Node on first run — allow it on **Private** networks.
Give the PC a fixed IP (or DHCP reservation) so the iPad bookmark keeps working.

## 2. Print agent (PC #2)

```bash
cd print-agent
npm install                 # pulls `sharp` (image processing); `usb` is optional and may fail to build — that's fine
```

Edit `config.js`:

| Setting | What |
|---|---|
| `serverUrl` | `http://<booth-pc-ip>:8080` |
| `agentKey` | same value as `AGENT_KEY` on the server |
| `printer.type` | `tcp` (Ethernet/Wi-Fi printer, port 9100), `windows-raw` (printer installed in Windows — easiest on Windows), `usb` (raw USB via libusb/WinUSB), or `file` (debug) |
| `printer.widthDots` | **384** for 58 mm paper, **576** for 80 mm paper |
| `layout.dither` | `atkinson` (clean, lighter), `floyd` (more photographic), `threshold` |
| `layout.brightness/contrast/gamma` | tweak until it looks right on *your* paper |

Then:

```bash
npm run test-print          # prints a gradient test pattern — confirms the printer link and lets you tune dithering
npm start                   # opens the counter UI at http://localhost:3000
```

CLI alternative, no browser needed:

```bash
node cli.js K7MQ2X                        # print that code
node cli.js --preview K7MQ2X out.png      # see what it'll look like without printing
```

### Which printer transport?

- **Windows + USB thermal printer with the vendor driver installed** → `windows-raw`, set `windowsPrinterName`
  to the name shown in *Printers & scanners* (e.g. `POS-80`, `XP-58`). No extra drivers.
- **Printer with an Ethernet/Wi-Fi port** → `tcp`, host = printer IP, port 9100 (print its self-test page to find the IP).
- **Linux/macOS + USB** → `file` with `filePath: '/dev/usb/lp0'`, or `usb`.
- `usb` on Windows needs the printer switched to the WinUSB driver using Zadig — only do this if the others don't work.

### Tuning the print

Thermal paper has no gray, so the photo is dithered to pure black/white dots. Use `npm run test-print` or
`--preview` and adjust:

- Faces too dark / muddy → raise `brightness` (1.1–1.25) or `gamma`.
- Washed out → raise `contrast`.
- Printer prints garbage or stops mid-image → lower `stripRows` to 64 and set `stripDelayMs` to 30.
- Image is cropped on the right → `widthDots` is too large for your paper (try 384).
- Image is squashed to the left → `widthDots` is too small.

## How the pieces talk

| Endpoint (server) | Who | Purpose |
|---|---|---|
| `POST /api/photos` `{image: dataURL}` | iPad | save JPEG, returns `{code}` |
| `GET /api/photos/:code` | agent (`X-Agent-Key`) | metadata |
| `GET /api/photos/:code/image` | agent | the JPEG |
| `POST /api/photos/:code/printed` | agent | bump print counter |
| `GET /admin` | you | list of all photos |

Codes use the alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no 0/O/1/I/L, so they're unambiguous when
handwritten or read aloud.

## Two modes

After "Let's go" the guest picks a mode:

- **Photo Booth** — pick 1–4 snaps, countdown for each, pose.
- **Rawr Mode** — the mic opens and a loudness meter appears. Tap the shutter, 3-2-1, then **ROAR** for 4 seconds:
  the "RAWR!" on screen grows with the volume, and 3 snaps are taken at random moments during the roar (at least
  0.8 s apart). The peak loudness becomes a score (0–100 %) with a rating — *a tiny squeak / a decent grumble /
  a mighty roar / LEGENDARY* — printed under the strip as `ROAR POWER 97%  LEGENDARY`.

Rawr mode needs microphone permission (Safari asks the first time; the certificate trust step above covers it).
The loudness scale is set in `micLevel()` in `index.html` (−60 dB → 0 %, −5 dB → 100 %); if kids max it out too
easily, raise the upper number.

## Theme and strip layout

The booth is themed **Hotel Transylvania** (the group's drawn theme): a neon HOTEL sign, an original castle
skyline with moon and bats, midnight palette with a vampire-red accent. All artwork is original SVG — no film
characters or logo — and no network fonts, so it works at a venue with no internet. Guests pick 1–4 snaps; the snaps are stacked top-to-bottom into one strip image with a
black-on-white header and footer, and that strip is what gets saved and printed.

Everything adjustable is in the `THEME` object at the top of `server/public/index.html`:

| Key | Default | What |
|---|---|---|
| `title` / `subtitle` | `HOTEL TRANSYLVANIA` / `More Power Halloween 2026` | printed in the strip header / footer |
| `maxSnaps` | 4 | how many choices the guest gets |
| `frameW` × `frameH` | 1200 × 900 | each snap (4:3). On 80 mm paper a snap is ≈ 55 mm tall; 3 snaps ≈ 175 mm of paper |
| `pad`, `gap`, `headerH`, `footerH` | — | strip spacing in px (1200 px strip width = 576 printer dots) |

Colors are CSS variables in `:root` (`--cream` = page ground, `--cocoa` = text, `--orange` = primary action,
`--purple`, `--green`, `--moon`, `--neon`). The castle is the inline `<symbol id="castle">` SVG; the strip's bats
are drawn by `drawBat()` on the canvas.

## Ideas for later

- Print 2 copies: call `send()` twice in `print.js`, or add a "copies" field to the counter UI.
- Overlay a logo or event name on the photo before upload (draw it on the canvas in `capture()`).
- QR code on the receipt pointing to a download page for the color version.
- Replace `index.json` with SQLite if you'll have thousands of photos.
