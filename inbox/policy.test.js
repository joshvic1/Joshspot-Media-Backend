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
test('template variables support numbered and named approved template parameters', () => {
  const template = { name: 'welcome', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hello {{1}}, your course is {{2}}.' }] };
  const result = p.templatePayload(template, { 'body.1': 'Ada', 'body.2': 'WhatsApp Ads' });
  assert.equal(result.preview, 'Hello Ada, your course is WhatsApp Ads.');
  assert.equal(result.payload.components[0].parameters.length, 2);
  assert.throws(() => p.templatePayload(template, { 'body.1': 'Ada' }));
  assert.throws(() => p.templatePayload({ ...template, status: 'PENDING' }, {}));
  assert.deepEqual(p.templateFields({ components: [{ type: 'BUTTONS', buttons: [] }] }), []);
  const named = { name: 'named', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{customer_name}}' }] };
  const namedResult = p.templatePayload(named, { 'body.customer_name': 'Ada' });
  assert.deepEqual(namedResult.payload.components[0].parameters[0], { type: 'text', parameter_name: 'customer_name', text: 'Ada' });
});
test('template payload supports media headers, dynamic buttons and locations', () => {
  const media = { name: 'photo', language: 'en', status: 'APPROVED', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open', url: 'https://example.test/{{1}}' }] }] };
  const fields = p.templateFields(media); assert.equal(fields.find(field => field.kind === 'media').key, 'header.media'); assert.ok(fields.find(field => field.key === 'button.0.url.1'));
  const result = p.templatePayload(media, { 'body.1': 'Ada', 'button.0.url.1': 'offer', 'header.media': 'untrusted' }, { 'header.media': { id: 'media-id', type: 'image', name: 'photo.png' } });
  assert.deepEqual(result.payload.components[0], { type: 'header', parameters: [{ type: 'image', image: { id: 'media-id' } }] });
  assert.deepEqual(result.payload.components[2], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'offer' }] });
  const location = { name: 'location', language: 'en', status: 'APPROVED', components: [{ type: 'HEADER', format: 'LOCATION' }] };
  const locationResult = p.templatePayload(location, { 'header.location.latitude': '6.5244', 'header.location.longitude': '3.3792', 'header.location.name': 'Lagos', 'header.location.address': 'Nigeria' });
  assert.equal(locationResult.payload.components[0].parameters[0].location.name, 'Lagos');
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
