// Writes and removes only its own newly generated probe object; no database or bucket listing.
require('dotenv').config({ quiet: true });
const { randomBytes } = require('node:crypto');
const storage = require('../inbox/mediaStorage');
(async () => {
 const key = storage.keyFor(randomBytes(12).toString('hex')); let written = false;
 try {
  await storage.put(key, Buffer.from('Joshspot Inbox storage connection check'), 'text/plain'); written = true;
  const url = await storage.link({ key, name: 'inbox-check.txt' });
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok || await response.text() !== 'Joshspot Inbox storage connection check') throw Error('Read check failed');
  console.log('PASS: configured R2 upload and private signed download.');
 } finally { if (written) { await storage.remove(key); console.log('PASS: only the newly created probe object was removed.'); } }
})().catch(error => { console.error('R2 check failed:', error.name, error.$metadata?.httpStatusCode || ''); process.exitCode = 1; });
