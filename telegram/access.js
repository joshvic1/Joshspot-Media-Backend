const crypto = require('node:crypto');
const Invoice = require('../models/Invoice');
const Channel = require('../models/TelegramCourseChannel');
const Identity = require('../models/TelegramCourseIdentity');
const Invite = require('../models/TelegramCourseInvite');
const Access = require('../models/TelegramCourseAccess');
const telegram = require('./client');

const COURSE_PRODUCTS = new Set(['ads-course', 'whatsapp-course']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_LIFETIME_MS = 30 * 60 * 1000;

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : '';
}

function botUrl(invoice) {
  const username = String(process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  if (!username) return '';
  const token = String(invoice?.telegramAccessToken || '').trim();
  return `https://t.me/${username}${token ? `?start=${encodeURIComponent(token)}` : ''}`;
}

function paidCourseQuery(email) {
  return { status: 'paid', deletedAt: null, product: { $in: [...COURSE_PRODUCTS] }, customerEmail: email };
}

async function ensureInvoiceAccessToken(invoice) {
  if (!invoice || !COURSE_PRODUCTS.has(invoice.product)) return invoice;
  if (invoice.telegramAccessToken) return invoice;
  const token = crypto.randomBytes(24).toString('base64url');
  const saved = await Invoice.findOneAndUpdate(
    { _id: invoice._id, telegramAccessToken: { $in: [null, ''] } },
    { $set: { telegramAccessToken: token } },
    { returnDocument: 'after' },
  );
  return saved || await Invoice.findById(invoice._id);
}

async function telegramUrlForInvoice(invoice) {
  const current = await ensureInvoiceAccessToken(invoice);
  return botUrl(current);
}

async function paidInvoices(email) {
  return Invoice.find(paidCourseQuery(email)).sort({ paidAt: -1, createdAt: -1 });
}

async function entitledProducts(email) {
  const rows = await paidInvoices(email);
  return [...new Set(rows.map((row) => row.product))];
}

async function bindIdentity({ telegramUser, email, accessToken = '' }) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'invalid_email' };
  const invoices = await paidInvoices(normalized);
  if (!invoices.length) return { ok: false, reason: 'not_paid' };

  if (accessToken) {
    const matchingToken = invoices.some((invoice) => invoice.telegramAccessToken === accessToken);
    if (!matchingToken) return { ok: false, reason: 'not_paid' };
  }

  const telegramUserId = String(telegramUser.id);
  let identity = await Identity.findOne({ email: normalized });
  if (identity && identity.telegramUserId !== telegramUserId) return { ok: false, reason: 'bound_elsewhere' };
  if (identity?.revokedAt) return { ok: false, reason: 'revoked' };

  const values = {
    telegramUserId,
    telegramUsername: String(telegramUser.username || '').slice(0, 100),
    telegramName: [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').slice(0, 160),
    lastAccessAt: new Date(),
  };
  if (!identity) {
    try {
      identity = await Identity.create({ email: normalized, ...values, boundAt: new Date() });
    } catch (error) {
      if (error.code !== 11000) throw error;
      identity = await Identity.findOne({ email: normalized });
      if (!identity || identity.telegramUserId !== telegramUserId) return { ok: false, reason: 'bound_elsewhere' };
    }
  } else {
    identity = await Identity.findByIdAndUpdate(identity._id, { $set: values }, { returnDocument: 'after' });
  }
  return { ok: true, identity, invoices };
}

async function issueLinks(identity) {
  const products = await entitledProducts(identity.email);
  const channels = await Channel.find({ active: true, product: { $in: products } }).sort({ product: 1, createdAt: 1 });
  if (!channels.length) return { configured: false, links: [] };

  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS);
  const links = [];
  for (const channel of channels) {
    const result = await telegram.call('createChatInviteLink', {
      chat_id: channel.chatId,
      name: `Course access ${String(identity._id).slice(-6)}`,
      expire_date: Math.floor(expiresAt.getTime() / 1000),
      creates_join_request: true,
    });
    await Invite.create({
      inviteLink: result.invite_link,
      identity: identity._id,
      channel: channel._id,
      telegramUserId: identity.telegramUserId,
      expiresAt,
    });
    links.push({ title: channel.title, url: result.invite_link });
  }
  return { configured: true, links };
}

async function sendCourseLinks(identity) {
  const access = await issueLinks(identity);
  if (!access.configured) return { ...access, sent: false };
  const buttons = access.links.map((item) => [{ text: `Access ${item.title}`, url: item.url }]);
  await telegram.call('sendMessage', {
    chat_id: identity.telegramUserId,
    text: 'Your course access is ready. Select the course below and request to join. Access is approved only for this Telegram account.',
    reply_markup: { inline_keyboard: buttons },
    disable_web_page_preview: true,
  });
  return { ...access, sent: true };
}

async function approveJoinRequest(request) {
  const inviteLink = request?.invite_link?.invite_link;
  const telegramUserId = String(request?.from?.id || '');
  if (!inviteLink || !telegramUserId) return false;
  const invite = await Invite.findOne({ inviteLink, status: 'active' }).populate('identity channel');
  if (!invite || invite.expiresAt <= new Date()) {
    if (invite) await Invite.updateOne({ _id: invite._id }, { $set: { status: 'expired' } });
    await telegram.call('declineChatJoinRequest', { chat_id: request.chat.id, user_id: request.from.id });
    return false;
  }
  const identity = invite.identity;
  const channel = invite.channel;
  const permitted = identity && channel && !identity.revokedAt && invite.telegramUserId === telegramUserId && String(channel.chatId) === String(request.chat.id) && (await entitledProducts(identity.email)).includes(channel.product);
  if (!permitted) {
    await Invite.updateOne({ _id: invite._id }, { $set: { status: 'declined', declinedAt: new Date() } });
    await telegram.call('declineChatJoinRequest', { chat_id: request.chat.id, user_id: request.from.id });
    return false;
  }
  const invoice = await Invoice.findOne({ ...paidCourseQuery(identity.email), product: channel.product }).sort({ paidAt: -1, createdAt: -1 });
  if (!invoice) {
    await telegram.call('declineChatJoinRequest', { chat_id: request.chat.id, user_id: request.from.id });
    return false;
  }
  await telegram.call('approveChatJoinRequest', { chat_id: request.chat.id, user_id: request.from.id });
  await Access.findOneAndUpdate({ identity: identity._id, channel: channel._id }, {
    $set: { invoice: invoice._id, telegramUserId, status: 'approved', approvedAt: new Date(), revokedAt: null, revokedReason: '' },
  }, { upsert: true, returnDocument: 'after' });
  await Invite.updateOne({ _id: invite._id }, { $set: { status: 'approved', approvedAt: new Date() } });
  return true;
}

async function revokeIdentity(identity, reason = '') {
  const accesses = await Access.find({ identity: identity._id, status: 'approved' }).populate('channel');
  const outcomes = [];
  for (const access of accesses) {
    try {
      await telegram.call('banChatMember', { chat_id: access.channel.chatId, user_id: Number(identity.telegramUserId) });
      outcomes.push({ access, ok: true });
    } catch (error) { outcomes.push({ access, ok: false, error }); }
  }
  if (outcomes.some((item) => !item.ok)) throw Object.assign(new Error('Telegram could not remove access from every channel.'), { status: 502, safe: true });
  await Access.updateMany({ identity: identity._id, status: 'approved' }, { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: String(reason).slice(0, 500) } });
  return Identity.findByIdAndUpdate(identity._id, { $set: { revokedAt: new Date(), revokedReason: String(reason).slice(0, 500) } }, { returnDocument: 'after' });
}

async function restoreIdentity(identity) {
  const products = await entitledProducts(identity.email);
  const channels = await Channel.find({ active: true, product: { $in: products } });
  for (const channel of channels) {
    await telegram.call('unbanChatMember', { chat_id: channel.chatId, user_id: Number(identity.telegramUserId), only_if_banned: true });
  }
  const restored = await Identity.findByIdAndUpdate(identity._id, { $unset: { revokedAt: 1, revokedReason: 1 }, $set: { lastAccessAt: new Date() } }, { returnDocument: 'after' });
  await sendCourseLinks(restored);
  return restored;
}

module.exports = { COURSE_PRODUCTS, normalizeEmail, botUrl, paidInvoices, ensureInvoiceAccessToken, telegramUrlForInvoice, bindIdentity, sendCourseLinks, approveJoinRequest, revokeIdentity, restoreIdentity };
