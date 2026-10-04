const maskPhone = value => {
  const raw = String(value || '');
  if (raw.includes('*')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  const visible = Math.min(5, Math.max(1, digits.length - 5));
  return '+' + digits.slice(0, visible) + '*'.repeat(Math.max(4, digits.length - visible - 1)) + digits.slice(-1);
};
function maskPhoneFields(value) {
  if (Array.isArray(value)) return value.map(maskPhoneFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(phone|customerPhone|clientNumber|phoneNumber|mobile|telephone)$/i.test(key) && typeof item === 'string'
      ? (key === 'phone' ? maskPhone(item).replace(/^\+/, '') : maskPhone(item)) : maskPhoneFields(item)]));
}
module.exports = { maskPhone, maskPhoneFields };
