// Self-signed certificate management.
// ensureCert() returns { key, cert } — generating or regenerating certs/ when missing or when the
// certificate doesn't cover this machine's current LAN IP (so a changed DHCP address just works).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

export function lanIps() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export function generate(certDir, extra = []) {
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: 'photobooth.local' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIps().map((ip) => ({ type: 7, ip })),
    ...extra.map((v) => (/^\d+\.\d+\.\d+\.\d+$/.test(v) ? { type: 7, ip: v } : { type: 2, value: v })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Photobooth' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  mkdirSync(certDir, { recursive: true });
  writeFileSync(join(certDir, 'key.pem'), pems.private);
  writeFileSync(join(certDir, 'cert.pem'), pems.cert);
  return { key: pems.private, cert: pems.cert, covers: altNames.map((a) => a.ip || a.value) };
}

export function ensureCert(certDir, extra = []) {
  const keyPath = join(certDir, 'key.pem'), certPath = join(certDir, 'cert.pem');
  if (existsSync(keyPath) && existsSync(certPath)) {
    const cert = readFileSync(certPath, 'utf8');
    const san = new X509Certificate(cert).subjectAltName || '';
    const missing = [...lanIps(), ...extra].filter((v) => !san.includes(v));
    if (missing.length === 0) return { key: readFileSync(keyPath, 'utf8'), cert, covers: san, regenerated: false };
    console.log(`[cert] existing certificate doesn't cover ${missing.join(', ')} — regenerating`);
  }
  return { ...generate(certDir, extra), regenerated: true };
}
