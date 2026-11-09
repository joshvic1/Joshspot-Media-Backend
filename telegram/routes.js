const express = require('express');
const Session = require('../models/TelegramCourseSession');
const Channel = require('../models/TelegramCourseChannel');
const telegram = require('./client');
const access = require('./access');

const router = express.Router();

function displayName(user) {
  return [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'there';
}

async function reply(chatId, text) {
  return telegram.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

router.post('/webhook', async (req, res) => {
  if (!telegram.configured() || !telegram.safeEqual(req.headers['x-telegram-bot-api-secret-token'], process.env.TELEGRAM_WEBHOOK_SECRET || '')) return res.sendStatus(404);
  res.sendStatus(200);
  const update = req.body || {};
  try {
    if (update.channel_post?.chat?.id) {
      const chat = update.channel_post.chat;
      await Channel.findOneAndUpdate({ chatId: String(chat.id) }, { $setOnInsert: { chatId: String(chat.id), title: String(chat.title || 'Telegram channel'), product: 'ads-course', active: false, discoveredAt: new Date() } }, { upsert: true });
      return;
    }
    if (update.chat_join_request) { await access.approveJoinRequest(update.chat_join_request); return; }
    const message = update.message;
    if (!message?.from || message.chat?.type !== 'private' || typeof message.text !== 'string') return;
    const user = message.from;
    const telegramUserId = String(user.id);
    const text = message.text.trim();
    const start = /^\/start(?:\s+([A-Za-z0-9_-]{1,64}))?$/i.exec(text);
    if (start) {
      await Session.findOneAndUpdate({ telegramUserId }, { $set: { accessToken: start[1] || '', state: 'awaiting_email', expiresAt: new Date(Date.now() + 30 * 60 * 1000) } }, { upsert: true, returnDocument: 'after' });
      await reply(message.chat.id, `Welcome ${displayName(user)}. Please enter the email address you used while paying for your course.`);
      return;
    }
    const session = await Session.findOne({ telegramUserId, state: 'awaiting_email', expiresAt: { $gt: new Date() } });
    if (!session) { await reply(message.chat.id, 'Tap Start, then enter the email address you used while paying for your course.'); return; }
    const result = await access.bindIdentity({ telegramUser: user, email: text, accessToken: session.accessToken });
    if (!result.ok) {
      const messages = { invalid_email: 'Please enter a valid email address.', bound_elsewhere: 'This course email is already linked to another Telegram account. Please contact support if you need help.', revoked: 'Course access is currently unavailable. Please contact support.', not_paid: 'We could not confirm a paid course with that email. Please make sure you enter the email used while paying.' };
      await reply(message.chat.id, messages[result.reason] || 'We could not complete course access. Please try again later.');
      return;
    }
    await Session.deleteOne({ _id: session._id });
    const links = await access.sendCourseLinks(result.identity);
    if (!links.configured) await reply(message.chat.id, 'Your payment is confirmed. Course channel access is being prepared; please try again shortly.');
  } catch (error) { console.error('TELEGRAM COURSE WEBHOOK ERROR', { message: error.message, telegram: error.telegram }); }
});

module.exports = router;
