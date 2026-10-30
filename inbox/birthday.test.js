const test = require('node:test');
const assert = require('node:assert/strict');
const birthday = require('./birthday');

test('birthday availability covers only October 30 in Africa/Lagos', () => {
  assert.equal(birthday.isActive(new Date('2026-10-29T22:59:59.999Z')), false);
  assert.equal(birthday.isActive(new Date('2026-10-29T23:00:00.000Z')), true);
  assert.equal(birthday.isActive(new Date('2026-10-30T22:59:59.999Z')), true);
  assert.equal(birthday.isActive(new Date('2026-10-30T23:00:00.000Z')), false);
});

test('birthday authorization is limited to the one administrator identity and the one CSS account', () => {
  assert.equal(birthday.isAuthorized({ admin: true, id: 'admin' }), true);
  assert.equal(birthday.isAuthorized({ id: birthday.customerSupportStaffId, role: 'CSS' }), true);
  assert.equal(birthday.isAuthorized({ id: '6a4fa5d8bf99d3294e4f2259', role: 'SS' }), false);
  assert.equal(birthday.isAuthorized({ id: 'another-css-account', role: 'CSS' }), false);
});
