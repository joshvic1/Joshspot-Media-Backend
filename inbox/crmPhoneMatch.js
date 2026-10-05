const { phone } = require('./policy');
// Match formatting variants only, never partial numbers or customer names.
module.exports = function crmPhoneMatch(value) {
  const number = phone(value);
  const variants = [number, '+' + number, '00' + number];
  if (number.startsWith('234')) variants.push('0' + number.slice(3));
  const escaped = variants.map(v => [...v].map(ch => ch === '+' ? '\\+' : ch).join('[\\s().-]*'));
  return new RegExp('^[\\s().-]*(?:' + escaped.join('|') + ')[\\s().-]*$');
};
