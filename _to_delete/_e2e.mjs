import { testPatternJpeg, backend } from './escpos.js';
const jpg = await testPatternJpeg();
console.log('image backend here:', backend, '| test jpeg bytes:', jpg.length);
const dataUrl = 'data:image/jpeg;base64,' + jpg.toString('base64');

// 1. iPad → server
let r = await fetch('http://localhost:8080/api/photos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) });
const { code } = await r.json(); console.log('1. upload →', r.status, 'code =', code);

// 2. agent lookup (wrong key, then right key)
r = await fetch(`http://localhost:8080/api/photos/${code}`, { headers: { 'X-Agent-Key': 'wrong' } }); console.log('2a. lookup wrong key →', r.status);
r = await fetch(`http://localhost:8080/api/photos/${code.toLowerCase()}`, { headers: { 'X-Agent-Key': 'test-key-123' } }); console.log('2b. lookup lowercase →', r.status, await r.json());
r = await fetch(`http://localhost:8080/api/photos/ZZZZZZ`, { headers: { 'X-Agent-Key': 'test-key-123' } }); console.log('2c. lookup unknown →', r.status);

// 3. image fetch
r = await fetch(`http://localhost:8080/api/photos/${code}/image`, { headers: { 'X-Agent-Key': 'test-key-123' } });
const img = Buffer.from(await r.arrayBuffer()); console.log('3. image →', r.status, r.headers.get('content-type'), img.length, 'bytes, same as upload:', img.equals(jpg));

// 4. mark printed
r = await fetch(`http://localhost:8080/api/photos/${code}/printed`, { method: 'POST', headers: { 'X-Agent-Key': 'test-key-123' } }); console.log('4. printed →', r.status, (await r.json()).prints, 'print(s)');

// 5. https works too
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
r = await fetch('https://localhost:8443/api/health'); console.log('5. https health →', r.status, await r.json());
console.log('CODE=' + code);
