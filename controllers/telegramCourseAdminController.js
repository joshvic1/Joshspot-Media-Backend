const mongoose = require('mongoose');
const Channel = require('../models/TelegramCourseChannel');
const Identity = require('../models/TelegramCourseIdentity');
const Access = require('../models/TelegramCourseAccess');
const telegram = require('../telegram/client');
const { revokeIdentity, restoreIdentity } = require('../telegram/access');

const PRODUCTS = new Set(['ads-course', 'whatsapp-course']);

function webhookUrl() {
  return String(process.env.TELEGRAM_WEBHOOK_URL || '').trim().replace(/\/$/, '');
}

function setupStatus() {
  return {
    enabled: process.env.TELEGRAM_ENABLED === 'true',
    tokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    usernameConfigured: Boolean(process.env.TELEGRAM_BOT_USERNAME),
    secretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    webhookConfigured: Boolean(webhookUrl()),
    ready: telegram.configured() && Boolean(process.env.TELEGRAM_WEBHOOK_SECRET) && Boolean(webhookUrl()),
    botUsername: String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
  };
}

function publicChannel(channel) {
  return {
    id: String(channel._id),
    title: channel.title,
    chatId: channel.chatId,
    product: channel.product,
    active: Boolean(channel.active),
    discoveredAt: channel.discoveredAt,
    updatedAt: channel.updatedAt,
  };
}

function cleanChannelInput(body) {
  const title = String(body?.title || '').trim();
  const chatId = String(body?.chatId || '').trim();
  const product = String(body?.product || '').trim();
  if (!title || title.length > 120) return { error: 'Enter a channel name of up to 120 characters.' };
  if (!/^-?\d{4,30}$/.test(chatId)) return { error: 'Enter the numeric Telegram channel ID (for example, -100…).' };
  if (!PRODUCTS.has(product)) return { error: 'Choose the course this channel belongs to.' };
  return { title, chatId, product, active: body?.active !== false };
}

async function accessRows() {
  const identities = await Identity.find({}).sort({ updatedAt: -1 }).lean();
  const identityIds = identities.map((item) => item._id);
  const accesses = identityIds.length
    ? await Access.find({ identity: { $in: identityIds } }).populate('channel', 'title product active').lean()
    : [];
  const byIdentity = new Map();
  for (const row of accesses) {
    const key = String(row.identity);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push({
      id: String(row._id), status: row.status, approvedAt: row.approvedAt, revokedAt: row.revokedAt,
      channel: row.channel ? { title: row.channel.title, product: row.channel.product, active: Boolean(row.channel.active) } : null,
    });
  }
  return identities.map((identity) => ({
    id: String(identity._id),
    email: identity.email,
    telegram: { id: identity.telegramUserId, username: identity.telegramUsername || '', name: identity.telegramName || '' },
    boundAt: identity.boundAt,
    lastAccessAt: identity.lastAccessAt,
    revokedAt: identity.revokedAt || null,
    revokedReason: identity.revokedReason || '',
    access: byIdentity.get(String(identity._id)) || [],
  }));
}

exports.status = async (_req, res) => {
  try {
    const [channels, identities] = await Promise.all([
      Channel.find({}).sort({ active: -1, product: 1, createdAt: 1 }).lean(),
      accessRows(),
    ]);
    return res.json({
      setup: setupStatus(),
      channels: channels.map(publicChannel),
      identities,
      summary: {
        configuredChannels: channels.filter((item) => item.active).length,
        activeBuyers: identities.filter((item) => !item.revokedAt).length,
        revokedBuyers: identities.filter((item) => item.revokedAt).length,
      },
    });
  } catch (error) {
    console.error('TELEGRAM COURSE ADMIN STATUS ERROR', error.message);
    return res.status(500).json({ message: 'Unable to load Telegram course access.' });
  }
};

exports.setupWebhook = async (_req, res) => {
  const status = setupStatus();
  if (!status.ready) return res.status(400).json({ message: 'Add the Telegram token, username, webhook secret and webhook URL before connecting the bot.' });
  try {
    await telegram.call('setWebhook', {
      url: webhookUrl(),
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'chat_join_request', 'channel_post', 'my_chat_member'],
      drop_pending_updates: false,
    });
    const me = await telegram.call('getMe');
    return res.json({ message: `@${me.username || status.botUsername} is connected and ready to receive course-access updates.` });
  } catch (error) {
    console.error('TELEGRAM WEBHOOK SETUP ERROR', { message: error.message, telegram: error.telegram });
    return res.status(error.status || 502).json({ message: 'Telegram could not connect the webhook. Check the URL and bot permissions, then try again.' });
  }
};

exports.saveChannel = async (req, res) => {
  const values = cleanChannelInput(req.body);
  if (values.error) return res.status(400).json({ message: values.error });
  try {
    const channel = await Channel.findOneAndUpdate(
      { chatId: values.chatId },
      { $set: values, $setOnInsert: { discoveredAt: new Date() } },
      { upsert: true, returnDocument: 'after', runValidators: true },
    );
    return res.status(201).json({ channel: publicChannel(channel), message: 'Telegram course channel saved.' });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'That Telegram channel is already configured.' });
    return res.status(500).json({ message: 'Unable to save this Telegram channel.' });
  }
};

exports.updateChannel = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Telegram channel not found.' });
  const existing = await Channel.findById(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Telegram channel not found.' });
  const values = cleanChannelInput({ ...existing.toObject(), ...req.body, chatId: req.body?.chatId ?? existing.chatId });
  if (values.error) return res.status(400).json({ message: values.error });
  try {
    const channel = await Channel.findByIdAndUpdate(existing._id, { $set: values }, { returnDocument: 'after', runValidators: true });
    return res.json({ channel: publicChannel(channel), message: 'Telegram course channel updated.' });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'That Telegram channel is already configured.' });
    return res.status(500).json({ message: 'Unable to update this Telegram channel.' });
  }
};

exports.deactivateChannel = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Telegram channel not found.' });
  const channel = await Channel.findByIdAndUpdate(req.params.id, { $set: { active: false } }, { returnDocument: 'after' });
  if (!channel) return res.status(404).json({ message: 'Telegram channel not found.' });
  return res.json({ channel: publicChannel(channel), message: 'Channel disabled. New buyers will not receive access to it.' });
};

async function findIdentity(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ message: 'Buyer access record not found.' }); return null; }
  const identity = await Identity.findById(req.params.id);
  if (!identity) { res.status(404).json({ message: 'Buyer access record not found.' }); return null; }
  return identity;
}

exports.revoke = async (req, res) => {
  try {
    const identity = await findIdentity(req, res);
    if (!identity) return;
    if (identity.revokedAt) return res.status(409).json({ message: 'This buyer’s Telegram access is already revoked.' });
    await revokeIdentity(identity, String(req.body?.reason || '').trim());
    return res.json({ message: 'Telegram course access was revoked from this account.' });
  } catch (error) {
    console.error('TELEGRAM COURSE REVOKE ERROR', { message: error.message, telegram: error.telegram });
    return res.status(error.status || 502).json({ message: 'Telegram could not revoke this access from every mapped channel. Nothing was changed locally.' });
  }
};

exports.restore = async (req, res) => {
  try {
    const identity = await findIdentity(req, res);
    if (!identity) return;
    if (!identity.revokedAt) return res.status(409).json({ message: 'This buyer’s Telegram access is already active.' });
    await restoreIdentity(identity);
    return res.json({ message: 'Telegram course access was restored. New secure join links were sent to the linked Telegram account.' });
  } catch (error) {
    console.error('TELEGRAM COURSE RESTORE ERROR', { message: error.message, telegram: error.telegram });
    return res.status(error.status || 502).json({ message: 'Telegram could not restore this buyer’s access. Check the channel mapping and bot permissions.' });
  }
};
