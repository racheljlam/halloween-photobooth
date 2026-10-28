#!/usr/bin/env python3
"""BLE printer bridge for the ticket slip (GOOJPRT PT-210 and similar ESC/POS BLE printers).

Install once:   python3 -m pip install --user bleak
Scan:           python3 ble_print.py --scan
Inspect:        python3 ble_print.py --info PT210_8C73
Print a file:   python3 ble_print.py PT210_8C73 ticket.bin

The server calls this with TICKET_PRINTER=ble:PT210_8C73 (name prefix or MAC/UUID address).
"""
import asyncio, sys, time

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    print("bleak is not installed. Run:  python3 -m pip install --user bleak", file=sys.stderr)
    sys.exit(2)

CHUNK_DELAY = 0.03     # seconds between writes (the fast, original pacing)
ROW_SECONDS = 0.0      # extra per-row pacing for raster blocks; 0 = off. Set ~0.004 only if prints come out with gaps
STD_SERVICES = ("1800", "1801", "180a", "180f")   # generic access/attribute, device info, battery — never the print pipe


async def find(target: str, timeout=8.0):
    t = target.lower()
    devs = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for d, adv in devs.values():
        name = (d.name or adv.local_name or "")
        if d.address.lower() == t or name.lower().startswith(t):
            return d
    raise SystemExit(f"printer '{target}' not found. Is it on, and not connected to a phone? Try --scan")


def pick_write_char(client):
    """First writable characteristic outside the standard services. Prefer write-without-response (fast)."""
    cands = []
    for svc in client.services:
        if svc.uuid[4:8].lower() in STD_SERVICES:
            continue
        for ch in svc.characteristics:
            props = set(ch.properties)
            if "write" in props or "write-without-response" in props:
                cands.append((0 if "write-without-response" in props else 1, ch))
    if not cands:
        raise SystemExit("no writable characteristic found — run --info and send me the output")
    cands.sort(key=lambda c: c[0])
    return cands[0][1]


def split_units(data: bytes):
    """Split an ESC/POS stream into (bytes, rows) units: raster blocks (GS v 0) carry their row count so the
    sender can pace them; everything else is rows=0."""
    units, i, n, plain = [], 0, len(data), bytearray()
    while i < n:
        if data[i] == 0x1D and i + 7 < n and data[i + 1] == 0x76 and data[i + 2] == 0x30:
            bpr = data[i + 4] | (data[i + 5] << 8)
            rows = data[i + 6] | (data[i + 7] << 8)
            end = i + 8 + bpr * rows
            if plain:
                units.append((bytes(plain), 0)); plain = bytearray()
            units.append((data[i:end], rows))
            i = end
        else:
            plain.append(data[i]); i += 1
    if plain:
        units.append((bytes(plain), 0))
    return units


async def send_all(client, ch, units, start_unit):
    ack = "write-without-response" not in ch.properties
    mtu = getattr(client, "mtu_size", 23) or 23
    size = max(20, min(mtu - 3, 180))
    for u in range(start_unit, len(units)):
        buf, rows = units[u]
        t0 = time.monotonic()
        for i in range(0, len(buf), size):
            await client.write_gatt_char(ch, buf[i:i + size], response=ack)
            if not ack:
                await asyncio.sleep(CHUNK_DELAY)
        if rows and ROW_SECONDS:
            remaining = rows * ROW_SECONDS - (time.monotonic() - t0)
            if remaining > 0:
                await asyncio.sleep(remaining)
        yield u


async def print_bytes(target, data: bytes, retries=3):
    units = split_units(data)
    done = 0          # units fully sent
    attempt = 0
    while True:
        try:
            dev = await find(target)
            async with BleakClient(dev, timeout=15.0) as client:
                ch = pick_write_char(client)
                async for u in send_all(client, ch, units, done):
                    done = u + 1
                await asyncio.sleep(1.0)   # let the printer finish before the link drops
            return len(data)
        except Exception as e:          # link dropped mid-stream: reconnect and resume from the next unit
            attempt += 1
            if attempt > retries:
                raise
            print(f"link dropped after unit {done}/{len(units)} ({e.__class__.__name__}); reconnecting ({attempt}/{retries})", file=sys.stderr)
            await asyncio.sleep(2.0)


async def scan():
    devs = await BleakScanner.discover(timeout=6.0, return_adv=True)
    for d, adv in sorted(devs.values(), key=lambda x: -(x[1].rssi or -999)):
        print(f"{adv.rssi:5} dBm  {d.address}  {d.name or adv.local_name or '(no name)'}")


async def info(target):
    dev = await find(target)
    async with BleakClient(dev, timeout=15.0) as client:
        print("connected to", dev.name, dev.address, "mtu", getattr(client, "mtu_size", "?"))
        for svc in client.services:
            print("service", svc.uuid)
            for ch in svc.characteristics:
                print("   char", ch.uuid, ",".join(ch.properties))
        ch = pick_write_char(client)
        print("would write to:", ch.uuid, "unacknowledged (fast)" if "write-without-response" in ch.properties else "acknowledged")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "--scan":
        asyncio.run(scan())
    elif a[0] == "--info":
        asyncio.run(info(a[1]))
    else:
        target, path = a[0], a[1]
        t0 = time.time()
        n = asyncio.run(print_bytes(target, open(path, "rb").read()))
        print(f"sent {n} bytes to {target} in {time.time() - t0:.1f}s")
