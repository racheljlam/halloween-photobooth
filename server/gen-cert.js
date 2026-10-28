// Regenerate the HTTPS certificate by hand (the server also does this automatically on start).
// Usage: node gen-cert.js [extra-ip-or-hostname ...]
import { generate } from './cert.js';
const { covers } = generate('certs', process.argv.slice(2));
console.log('Wrote certs/key.pem and certs/cert.pem');
console.log('Covers:', covers.join(', '));
console.log('\nNote: after regenerating, the iPad must install + trust the NEW certificate (see /setup on the server).');
