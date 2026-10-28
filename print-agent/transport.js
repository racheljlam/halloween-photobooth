// Transports: send raw ESC/POS bytes to the printer.
import net from 'node:net';
import { writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTcp(chunks, p) {
  await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: p.host, port: p.port });
    sock.setTimeout(15000);
    sock.once('error', reject);
    sock.once('timeout', () => reject(new Error('printer connection timed out')));
    sock.once('connect', async () => {
      try {
        for (const c of chunks) {
          if (!sock.write(c)) await new Promise((r) => sock.once('drain', r));
          if (p.stripDelayMs) await sleep(p.stripDelayMs);
        }
        sock.end(resolve);
      } catch (e) { reject(e); }
    });
  });
}

async function sendUsb(chunks, p) {
  const { usb, findByIds, getDeviceList } = await import('usb');
  let dev;
  if (p.usbVendorId) dev = findByIds(p.usbVendorId, p.usbProductId || undefined);
  if (!dev) {
    // first device with a printer-class (7) interface
    dev = getDeviceList().find((d) =>
      d.configDescriptor?.interfaces?.some((alts) => alts.some((a) => a.bInterfaceClass === 7)));
  }
  if (!dev) throw new Error('no USB printer found (set usbVendorId/usbProductId, and install WinUSB driver with Zadig on Windows)');
  dev.open();
  const iface = dev.interfaces.find((i) => i.descriptor.bInterfaceClass === 7) || dev.interfaces[0];
  if (process.platform !== 'win32' && iface.isKernelDriverActive()) iface.detachKernelDriver();
  iface.claim();
  const ep = iface.endpoints.find((e) => e.direction === 'out');
  if (!ep) throw new Error('USB printer has no OUT endpoint');
  try {
    for (const c of chunks) {
      await new Promise((res, rej) => ep.transfer(c, (err) => (err ? rej(err) : res())));
      if (p.stripDelayMs) await sleep(p.stripDelayMs);
    }
  } finally {
    await new Promise((r) => iface.release(true, () => r()));
    dev.close();
  }
}

// Bluetooth SPP / USB serial device, e.g. /dev/tty.PT-210 on macOS. Paced writes — BT drops bytes if flooded.
async function sendSerial(chunks, p) {
  try { execFileSync('stty', ['-f', p.serialPath, 'raw', '-echo'], { stdio: 'ignore' }); } catch {}
  const fd = openSync(p.serialPath, 'r+');
  const size = p.serialChunkBytes || 256, delay = p.serialChunkDelayMs ?? 25;
  try {
    for (const c of chunks) {
      for (let i = 0; i < c.length; i += size) { writeSync(fd, c.subarray(i, i + size)); await sleep(delay); }
      if (p.stripDelayMs) await sleep(p.stripDelayMs);
    }
    await sleep(p.serialDrainMs ?? 1500);   // let Bluetooth flush before the link is torn down
  } finally { closeSync(fd); }
}

// Raw job through CUPS (macOS/Linux): printer added with `lpadmin -p NAME -E -v usb://... -m raw`
async function sendCups(chunks, p) {
  const f = join(tmpdir(), `photobooth-${Date.now()}.bin`);
  writeFileSync(f, Buffer.concat(chunks));
  execFileSync('lp', ['-d', p.cupsQueue, '-o', 'raw', f], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// Bluetooth LE via ble_print.py (python + bleak). Streams at ~6 KB/s, slower than the printer prints, so no overflow.
async function sendBle(chunks, p) {
  const f = join(tmpdir(), `photobooth-${Date.now()}.bin`);
  writeFileSync(f, Buffer.concat(chunks));
  const out = execFileSync(p.python || process.env.PYTHON || 'python3', [join(__dirname, 'ble_print.py'), p.bleName, f], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  console.log('[ble] ' + out.toString().trim());
}

async function sendFile(chunks, p) {
  writeFileSync(p.filePath, Buffer.concat(chunks));
}

// Spool raw bytes to a Windows printer queue through the vendor driver (RAW datatype).
async function sendWindowsRaw(chunks, p) {
  if (process.platform !== 'win32') throw new Error('windows-raw transport only works on Windows');
  const tmp = join(tmpdir(), `photobooth-${Date.now()}.bin`);
  writeFileSync(tmp, Buffer.concat(chunks));
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.IO; using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFOW { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr h, int l, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW d);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static void Send(string printer, string file) {
    byte[] bytes = File.ReadAllBytes(file); IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed: " + printer);
    var di = new DOCINFOW { pDocName = "Photobooth", pDataType = "RAW" };
    StartDocPrinter(h, 1, di); StartPagePrinter(h); int w;
    if (!WritePrinter(h, bytes, bytes.Length, out w)) throw new Exception("WritePrinter failed");
    EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
  }
}
"@
[RawPrinter]::Send('${p.windowsPrinterName.replace(/'/g, "''")}', '${tmp.replace(/'/g, "''")}')
`;
  await new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('PowerShell raw print failed: ' + err.trim()))));
  });
}

export async function send(chunks, printer) {
  switch (printer.type) {
    case 'tcp': return sendTcp(chunks, printer);
    case 'usb': return sendUsb(chunks, printer);
    case 'file': return sendFile(chunks, printer);
    case 'serial': return sendSerial(chunks, printer);
    case 'cups': return sendCups(chunks, printer);
    case 'ble': return sendBle(chunks, printer);
    case 'windows-raw': return sendWindowsRaw(chunks, printer);
    default: throw new Error('unknown printer.type: ' + printer.type);
  }
}
