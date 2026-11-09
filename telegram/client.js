const crypto = require('node:crypto');

const apiBase = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

function configured() {
  return Boolean(process.env.TELEGRAM_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME);
}

async function call(method, body = {}) {
  if (!configured()) throw Object.assign(new Error('Telegram course access is not configured.'), { status: 503, safe: true });
  const response = await fetch(`${apiBase()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const error = Object.assign(new Error('Telegram could not complete that action.'), { status: 502, safe: true });
    error.telegram = payload.description || response.status;
    throw error;
  }
  return payload.result;
}

function safeEqual(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

module.exports = { configured, call, safeEqual };
