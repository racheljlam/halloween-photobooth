# CLAUDE.md — Halloween Photobooth (MORE Power, Friendly Monster Mash, Oct 29 2026)

Project context for Claude Code sessions on any machine. Read this before touching anything.

## What this is

A two-part photobooth for a company Halloween party (theme: **Hotel Transylvania**), built by Rachel (IT).
Guests use an iPad in Safari; everything else runs on laptops on the same Wi-Fi. No internet needed at the venue.

```
iPad/phone Safari ──https──▶ server/      booth UI, saves strips, issues 6-char codes, prints the code SLIP
                                │
                                │ LAN http + X-Agent-Key
                                ▼
                            print-agent/  "front desk": type code → preview → prints the photo STRIP
```

- `server/` (Node 18+, Express, ESM). Ports **8443** https (booth) and **8080** http (agent API, `/setup`, `/admin`).
- `print-agent/` (Node, ESM). Port **3000** counter UI, plus `cli.js`. Converts the strip JPEG → 1-bit (Atkinson/Floyd dither) → ESC/POS raster.
- Plain JS, no build step, no bundler. Dependencies are vendored/installed per machine with `npm install`.

## Run commands (what actually works)

Booth server (Mac that the iPad talks to):
```bash
cd server && AGENT_KEY=yoursecret TICKET_PRINTER=tcp:192.168.192.168:9100 npm run dev
```
Print agent (same Mac or a Windows laptop; PowerShell uses `$env:X="..."` instead of `X=...`):
```bash
cd print-agent
export PRINTER_TYPE=tcp PRINTER_HOST=192.168.192.168 PRINTER_WIDTH=576 SERVER_URL=http://<booth-mac-ip>:8080 AGENT_KEY=yoursecret
node cli.js --test      # test pattern
npm run dev             # http://localhost:3000
node cli.js CODE        # print one strip from the terminal
```
`npm run dev` = `node --watch` (auto-restart). Use `npm start` on event day. `EADDRINUSE` → an old copy is running: `lsof -ti :8443 -ti :8080 | xargs kill`.

## Hardware facts (hard-won — don't re-discover)

- **Epson TM-T82III, Ethernet model** (serial X7B4027979). 80 mm, **576 dots**, auto-cutter, ESC/POS. USB socket is NOT usable on this unit.
  Factory static IP **192.168.192.168**/24, port 9100. Until it's switched to DHCP (its web page at that IP), the sending machine needs an
  alias on that subnet: mac `sudo ifconfig en0 alias 192.168.192.10 255.255.255.0`; windows `netsh interface ipv4 add address "Wi-Fi" 192.168.192.10 255.255.255.0`.
  Verify with `nc -z -v 192.168.192.168 9100`. Self-test = hold Feed while powering on.
- **GOOJPRT PT-210** (BLE name `PT210_8C73`), 58 mm, **384 dots**, no cutter, battery. Its USB is charge-only. macOS pairs it as a
  "keyboard" and the classic-BT serial port (`/dev/cu.PT210_8C73`) accepts bytes but never prints. **BLE works** via `ble_print.py`
  (python + `bleak`; venv at `server/.venv`): `PYTHON=.venv/bin/python TICKET_PRINTER=ble:PT210_8C73`, agent `PRINTER_TYPE=ble BLE_NAME=PT210_8C73 PRINTER_WIDTH=384`.
  It drops the link on long/dark prints when the battery is low — keep it on the charger. Continuous beeping at power-on = lid/paper/battery, not software.
  `node cli.js --reset` clears a half-received image. Thermal paper prints on one side only — blank output with paper moving = roll upside down.
- iPad Safari: camera/mic only on a **trusted https** page → guests' device installs the cert once via `http://<mac-ip>:8080/setup`
  (download profile → Settings install → Certificate Trust Settings → full trust). Cert auto-regenerates when the Mac's LAN IP changes.
  Safari has **no Bluetooth/USB** access, so the iPad can never print directly — the server prints the slip.

## Booth page (server/public/index.html) — single file, all config in the `THEME` object at the top

- Flow: Check in → mode picker (**Photo Booth** 1–4 snaps / **Rawr Mode**) → camera → strip review → room key (code) screen.
- Rawr Mode: mic loudness meter, 11 s roar window, first snap ≥ 3 s in, 2–3.2 s gaps, 3 snaps; peak % + rating printed on the strip
  (`ROAR POWER 97% LEGENDARY`). Camera+mic are requested in ONE `getUserMedia` call (two calls = multi-second mic delay on iOS);
  AudioContext is resumed synchronously inside the tap. Shutter is disabled until real audio samples arrive.
- Strip is composed on a canvas (1968 px wide, frames 1800×1350, header `HOTEL TRANSYLVANIA` with bats, footer `MORE Power Halloween 2026`,
  credit `brought to you by < IT />`) and uploaded as one JPEG — the print agent never recomposes it.
- Palette: midnight `--cream:#17123A`, text `--cocoa:#FFF4DA`, red `--orange:#E63946`, grape `--purple`, gold `--green`, `--moon`, `--neon`.
  (Variable names are historical; the comment in `:root` maps them.) Artwork is original SVG (castle, bats) — no film characters/logo, on purpose.
- Gotchas fixed before: `#shot` must be toggled with explicit `display:block/none`; the camera view is reset BEFORE the screen shows
  (`resetCamView()`), otherwise the previous guest's strip flashes for a few seconds.

## Print tuning (print-agent/config.js, all overridable by env)

`PRINT_BRIGHTNESS` (1.25) `PRINT_CONTRAST` (1.2) `PRINT_GAMMA` (1.35) `PRINT_DITHER` (atkinson|floyd) · `PRINTER_HEAT` is OFF by default
(ESC 7 persisted on the Goojprt and caused grief). Faces too dark → raise gamma/brightness; washed out → raise contrast. Lighting at the booth
matters more than any of these: light the guests from the front.

## Server API (for the agent and admin)

`POST /api/photos {image,note}` → `{code}` · `GET /api/photos/:code[/image]` (header `X-Agent-Key`) · `POST /api/photos/:code/printed` ·
`POST /api/tickets/:code` reprint slip · `GET /admin` list + reprint links · `GET /cert`, `/setup`. Data: `server/photos/<CODE>.jpg` + `index.json`.
Codes use `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L).

## Working agreements

- Keep everything dependency-light and offline-capable; no CDNs/fonts from the network.
- Don't add the company logo image back (removed on request); "MORE Power" is spelled with MORE in caps.
- `.gitignore` keeps `node_modules/`, `certs/`, `photos/`, `.venv/`, `_to_delete/` out — never commit guest photos.
- The user is a lead dev but wants copy-pasteable commands; give the exact command, then one line on what it does.
- Testing without hardware: `PRINTER_TYPE=file` / `TICKET_PRINTER=file:…` write ESC/POS to a file; `node test/escpos.test.mjs` unit-tests
  the dither/raster; the booth UI can be driven headlessly with Playwright + Chromium's fake camera/mic (`--use-fake-device-for-media-stream`).
