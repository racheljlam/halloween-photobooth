// Print agent configuration. Edit this file (or use env vars).
export default {
  // Booth server (the PC the iPad talks to). HTTP port is fine on the LAN.
  serverUrl: process.env.SERVER_URL || 'http://192.168.1.10:8080',
  // Must match AGENT_KEY on the server
  agentKey: process.env.AGENT_KEY || 'change-me',

  // Local web UI for the print counter
  uiPort: Number(process.env.UI_PORT || 3000),

  printer: {
    // 'tcp'  : network printer (most Epson/Xprinter/Goojprt have an Ethernet/WiFi port, default 9100)
    // 'usb'  : raw USB via the `usb` package (needs WinUSB/libusb driver via Zadig on Windows)
    // 'serial': Bluetooth SPP or USB serial device — e.g. a GOOJPRT PT-210 paired with this Mac shows up as /dev/tty.PT-210
    // 'ble'  : Bluetooth LE printer (GOOJPRT PT-210) through ble_print.py — needs python with `bleak` (see PYTHON)
    // 'cups' : USB printer added to macOS/Linux as a RAW queue (lpadmin -p PT210 -E -v usb://... -m raw)
    // 'file' : write ESC/POS bytes to a file (debugging) or to a device like /dev/usb/lp0 on Linux
    // 'windows-raw': spool raw bytes to a Windows printer by its name (uses PowerShell, works with the
    //                vendor's normal driver — easiest option on Windows)
    type: process.env.PRINTER_TYPE || 'tcp',

    host: process.env.PRINTER_HOST || '192.168.1.200',
    port: Number(process.env.PRINTER_PORT || 9100),

    usbVendorId: process.env.USB_VID ? Number(process.env.USB_VID) : null, // null = first printer-class device
    usbProductId: process.env.USB_PID ? Number(process.env.USB_PID) : null,

    filePath: process.env.PRINTER_FILE || './out.bin',
    serialPath: process.env.PRINTER_SERIAL || '/dev/tty.PT-210',
    cupsQueue: process.env.PRINTER_QUEUE || 'PT210',
    bleName: process.env.BLE_NAME || 'PT210_8C73',       // BLE name prefix (or address) as shown by `ble_print.py --scan`
    python: process.env.PYTHON || 'python3',             // interpreter that has bleak installed, e.g. ../server/.venv/bin/python
    serialChunkBytes: 256, serialChunkDelayMs: 25,   // slow these down (128 / 40) if the printout has gaps
    windowsPrinterName: process.env.WINDOWS_PRINTER || 'POS-80',

    // Printable dots across: 58mm paper (GOOJPRT PT-210) = 384, 80mm paper = 576. Check your printer's manual.
    widthDots: Number(process.env.PRINTER_WIDTH || 576),
    // Some cheap printers choke on big raster blocks; send the image in strips of this many rows
    stripRows: Number(process.env.PRINTER_STRIP_ROWS || 128),   // use 24 for BLE printers
    // Milliseconds to pause between strips (0 for Epson/Star; try 20-50 for no-name printers that drop data)
    stripDelayMs: 0,
    // Feed + cut at end
    cut: true,
    feedLines: 4,
    // Print head heat (ESC 7: max dots, heating time, interval). Lower heating time = lighter print.
    // PT-210 default is about 7,80,2. Set PRINTER_HEAT=7,60,2 for lighter, 7,100,2 for darker. Empty = leave as is.
    // Off by default — some firmware keeps this setting. Lightness is handled by brightness/gamma below instead.
    heat: process.env.PRINTER_HEAT && process.env.PRINTER_HEAT !== 'off' ? process.env.PRINTER_HEAT.split(',').map(Number) : null,
  },

  layout: {
    header: '',                      // the strip already has its own header; set e.g. 'MONSTER BOOTH' to add one
    footer: 'Happy Halloween from MORE Power!',
    printCode: true,                 // print the pickup code under the photo
    printDate: true,
    // Dither: 'floyd' (photo-realistic), 'atkinson' (higher contrast, prints lighter/cleaner), 'threshold'
    dither: process.env.PRINT_DITHER || 'atkinson',
    // Tweak before dithering. Thermal paper darkens quickly so a little brightness + contrast helps.
    // Override from the shell while tuning: PRINT_BRIGHTNESS=1.3 PRINT_CONTRAST=1.2 PRINT_GAMMA=1.4 PRINT_DITHER=floyd
    brightness: Number(process.env.PRINT_BRIGHTNESS || 1.25),
    contrast: Number(process.env.PRINT_CONTRAST || 1.2),
    gamma: Number(process.env.PRINT_GAMMA || 1.35),
  },
};
