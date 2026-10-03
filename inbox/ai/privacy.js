const sensitive = text => /\b(password|passcode|otp|secret|api.?key|access.?token|card.?number|cvv|pin\s*(?:is|:))\b/i.test(text) || /\b(?:sk-|EAA)[A-Za-z0-9_-]{16,}\b/.test(text);
function redact(text) {
  if (sensitive(String(text || ''))) return '[Sensitive information excluded]';
  return String(text || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/\b\+?\d[\d\s-]{8,}\d\b/g,'[private number]').slice(0,6000);
}
module.exports = {sensitive,redact};
