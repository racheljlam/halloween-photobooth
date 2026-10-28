// CLI: node cli.js ABC123        → fetch + print
//      node cli.js --test        → print a test pattern (checks printer/transport without the server)
//      node cli.js --preview ABC123 preview.png  → write dithered preview to a file, no printing
import { writeFileSync } from 'node:fs';
import { printCode, preview } from './print.js';
import { testPatternJpeg, backend } from './escpos.js';

const [a, b, c] = process.argv.slice(2);

try {
  if (a === '--reset') {
    // factory-ish reset: init + default heat (7,80,2) + feed. Clears a half-sent image too.
    const { cmd } = await import('./escpos.js'); const { send } = await import('./transport.js'); const config = (await import('./config.js')).default;
    await send([Buffer.alloc(4096, 0), cmd.init, cmd.heat(7, 80, 2), cmd.init, cmd.text('printer reset OK'), cmd.feed(3)], config.printer);
    console.log('Reset sent.');
  } else if (a === '--test') {
    // gradient + circle so you can judge dither/contrast on your paper
    const jpg = await testPatternJpeg();
    await printCode('TEST', { imageOverride: jpg });
    console.log(`Test pattern sent (image backend: ${backend}).`);
  } else if (a === '--preview') {
    const p = await preview(b);
    if (!p) throw new Error('No photo with that code');
    writeFileSync(c || `${b}.png`, p.png);
    console.log(`Preview written to ${c || b + '.png'}`);
  } else if (a) {
    const rec = await printCode(a);
    console.log(`Printed ${rec.code} (taken ${rec.createdAt})`);
  } else {
    console.log('usage: node cli.js <CODE> | --test | --reset | --preview <CODE> [out.png]');
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
