const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const Staff = require('../models/Staff');
const { crmLogin } = require('../controllers/crmController');
const { adminLogin } = require('../controllers/adminController');
function response() {
  return { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}
test('staff email is normalized but passwords are matched exactly', async () => {
  const original = Staff.findOne;
  const secret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'isolated-login-test-secret';
  try {
    const hash = await bcrypt.hash('Exact password ', 4);
    Staff.findOne = async ({ email }) => {
      assert.equal(email, 'agent@example.test');
      return { _id: '0123456789abcdef01234567', role: 'SS', name: 'Test', email, password: hash };
    };
    const valid = response(); await crmLogin({ body: { email: ' Agent@Example.Test ', password: 'Exact password ' } }, valid);
    assert.equal(valid.code, 200); assert.ok(valid.data.token);
    const invalid = response(); await crmLogin({ body: { email: 'agent@example.test', password: 'Exact password' } }, invalid);
    assert.equal(invalid.code, 401);
  } finally { Staff.findOne = original; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});
test('admin login ignores email case without bypassing password checks', async () => {
  const keys = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'JWT_SECRET']; const prior = keys.map((key) => process.env[key]);
  Object.assign(process.env, { ADMIN_EMAIL: 'Admin@example.test', ADMIN_PASSWORD: 'Synthetic password', JWT_SECRET: 'isolated-test-secret' });
  try {
    const valid = response(); await adminLogin({ body: { email: ' ADMIN@EXAMPLE.TEST ', password: 'Synthetic password' } }, valid);
    assert.equal(valid.code, 200); assert.ok(valid.data.token);
    const invalid = response(); await adminLogin({ body: { email: 'admin@example.test', password: 'wrong' } }, invalid);
    assert.equal(invalid.code, 401);
  } finally { keys.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; }); }
});
test('workspace login falls back to admin only after a staff credential rejection', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/pages/api/workspace-login.js'), 'utf8');
  const { default: login } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const original = global.fetch;
  try {
    const calls = [];
    global.fetch = async (url) => { calls.push(url); return calls.length === 1 ? { status: 401, ok: false, json: async () => ({ message: 'Invalid credentials' }) } : { status: 200, ok: true, json: async () => ({ token: 'synthetic-token' }) }; };
    const valid = response(); await login({ method: 'POST', body: { email: 'admin@example.test', password: 'synthetic', admin: false } }, valid);
    assert.equal(valid.code, 200); assert.equal(valid.data.accountType, 'admin'); assert.ok(calls[0].endsWith('/crm/login')); assert.ok(calls[1].endsWith('/admin/login'));
    let count = 0; global.fetch = async () => { count++; return { status: 500, ok: false, json: async () => ({ message: 'Server error' }) }; };
    const unavailable = response(); await login({ method: 'POST', body: { email: 'x@example.test', password: 'synthetic', admin: false } }, unavailable);
    assert.equal(unavailable.code, 500); assert.equal(count, 1);
    global.fetch = async () => ({ status: 401, ok: false, json: async () => ({ message: 'Invalid credentials' }) });
    const invalid = response(); await login({ method: 'POST', body: { email: 'x@example.test', password: 'wrong', admin: false } }, invalid);
    assert.equal(invalid.code, 401); assert.equal(invalid.data.token, undefined);
  } finally { global.fetch = original; }
});
