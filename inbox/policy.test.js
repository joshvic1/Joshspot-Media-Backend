const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const p = require('./policy');
test('local development never implicitly consumes production Inbox jobs', () => {
  const { workerEnabled } = require('./workerPolicy');
  assert.equal(workerEnabled({}), false);
  assert.equal(workerEnabled({ NODE_ENV: 'development' }), false);
  assert.equal(workerEnabled({ RAILWAY_ENVIRONMENT_ID: 'production-host' }), true);
  assert.equal(workerEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(workerEnabled({ NODE_ENV: 'production', INBOX_WORKER_ENABLED: 'false' }), false);
  assert.equal(workerEnabled({ INBOX_WORKER_ENABLED: 'true' }), true);
});

test('normalizes Nigerian local, international and formatted phone numbers', () => {
  for (const number of ['0801 234 5678', '+234 (801) 234-5678', '002348012345678', '2348012345678']) assert.equal(p.phone(number), '2348012345678');
  assert.equal(p.phone('+1 (202) 555-0123'), '12025550123');
  for (const number of ['', '234ABC55555', '123', '000123456789', '080123456789012345']) assert.throws(() => p.phone(number));
});
test('24-hour window closes at the exact boundary', () => {
  const now = Date.now();
  assert.equal(p.windowOpen(new Date(now - 86400000 + 1), now), true);
  assert.equal(p.windowOpen(new Date(now - 86400000), now), false);
  assert.equal(p.windowOpen(null, now), false);
});
test('webhook signature authenticates the exact bytes', () => {
  const raw = Buffer.from('{"hello":"world"}');
  const secret = 'test-secret';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(p.signature(raw, signature, secret), true);
  assert.equal(p.signature(Buffer.from('{}'), signature, secret), false);
  assert.equal(p.signature(raw, signature, ''), false);
  assert.equal(p.signature(raw, 'sha256=oops', secret), false);
});
test('template variables must match an approved supported template', () => {
  const template = { name: 'welcome', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hello {{1}}, your course is {{2}}.' }] };
  const result = p.templatePayload(template, { 'body.1': 'Ada', 'body.2': 'WhatsApp Ads' });
  assert.equal(result.preview, 'Hello Ada, your course is WhatsApp Ads.');
  assert.equal(result.payload.components[0].parameters.length, 2);
  assert.throws(() => p.templatePayload(template, { 'body.1': 'Ada' }));
  assert.throws(() => p.templatePayload({ ...template, status: 'PENDING' }, {}));
  assert.equal(p.templateFields({ components: [{ type: 'BUTTONS', buttons: [] }] }), null);
  assert.equal(p.templateFields({ components: [{ type: 'BODY', text: 'Hi {{customer}}' }] }), null);
});
test('delivery states do not regress and only assigned agents can reply', () => {
  assert.equal(p.statusCanAdvance('read', 'sent'), false);
  assert.equal(p.statusCanAdvance('delivered', 'failed'), false);
  assert.equal(p.statusCanAdvance('unknown', 'delivered'), true);
  assert.equal(p.canReply({ id: 'a' }, { assignedTo: 'b' }), false);
  assert.equal(p.canReply({ id: 'a' }, { assignedTo: null }), false);
  assert.equal(p.canReply({ id: 'a' }, { assignedTo: 'a' }), true);
  assert.equal(p.canReply({ admin: true }, { assignedTo: 'b' }), true);
});
