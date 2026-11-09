const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// This test uses a disposable database and stubs the Telegram API. It never
// contacts Telegram, a payment provider, a customer or the production database.
process.env.TELEGRAM_ENABLED = 'true';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_BOT_USERNAME = 'joshspot_course_test_bot';

const Invoice = require('../models/Invoice');
const Channel = require('../models/TelegramCourseChannel');
const Identity = require('../models/TelegramCourseIdentity');
const Invite = require('../models/TelegramCourseInvite');
const Access = require('../models/TelegramCourseAccess');
const BindingAudit = require('../models/TelegramCourseBindingAudit');
const telegram = require('../telegram/client');
const courseAccess = require('../telegram/access');

const calls = [];
let inviteNumber = 0;
telegram.call = async (method, body) => {
  calls.push({ method, body });
  if (method === 'createChatInviteLink') return { invite_link: `https://t.me/+protected-${++inviteNumber}` };
  return true;
};

async function main() {
  const mongo = await MongoMemoryServer.create();
  try {
    await mongoose.connect(mongo.getUri());
    const email = 'buyer@example.com';
    const [adsInvoice, whatsappInvoice] = await Invoice.create([
      { token: 'telegram-ads', amount: 8000, product: 'ads-course', status: 'paid', customerEmail: email, customerName: 'Buyer', telegramAccessToken: 'ads-token' },
      { token: 'telegram-whatsapp', amount: 10000, product: 'whatsapp-course', status: 'paid', customerEmail: email, customerName: 'Buyer', telegramAccessToken: 'whatsapp-token' },
    ]);
    assert.match(courseAccess.botUrl(adsInvoice), /joshspot_course_test_bot\?start=ads-token$/);

    const [adsChannel, whatsappChannel] = await Channel.create([
      { title: 'Ads course', chatId: '-100000001', product: 'ads-course', active: true },
      { title: 'WhatsApp course', chatId: '-100000002', product: 'whatsapp-course', active: true },
    ]);

    const first = await courseAccess.bindIdentity({ telegramUser: { id: 500, username: 'buyer', first_name: 'Course', last_name: 'Buyer' }, email, accessToken: 'ads-token' });
    assert.equal(first.ok, true);
    assert.equal(first.invoices.length, 2);
    assert.equal((await courseAccess.bindIdentity({ telegramUser: { id: 501 }, email })).reason, 'bound_elsewhere');
    assert.equal((await courseAccess.bindIdentity({ telegramUser: { id: 501 }, email: 'not-paid@example.com' })).reason, 'not_paid');

    const issued = await courseAccess.sendCourseLinks(first.identity);
    assert.equal(issued.sent, true);
    assert.equal(issued.links.length, 2);
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 1);
    const invites = await Invite.find({ identity: first.identity._id });
    assert.equal(invites.length, 2);

    for (const invite of invites) {
      const channel = String(invite.channel) === String(adsChannel._id) ? adsChannel : whatsappChannel;
      const approved = await courseAccess.approveJoinRequest({
        invite_link: { invite_link: invite.inviteLink },
        from: { id: 500 },
        chat: { id: channel.chatId },
      });
      assert.equal(approved, true);
    }
    assert.equal(await Access.countDocuments({ identity: first.identity._id, status: 'approved' }), 2);

    const revoked = await courseAccess.revokeIdentity(await Identity.findById(first.identity._id), 'admin review');
    assert.ok(revoked.revokedAt);
    assert.equal(await Access.countDocuments({ identity: first.identity._id, status: 'revoked' }), 2);
    assert.equal(calls.filter((call) => call.method === 'banChatMember').length, 2);

    const restored = await courseAccess.restoreIdentity(revoked);
    assert.equal(restored.revokedAt, undefined);
    assert.equal(calls.filter((call) => call.method === 'unbanChatMember').length, 2);
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 2);

    const reset = await courseAccess.resetIdentityBinding(await Identity.findById(first.identity._id), 'customer changed Telegram account');
    assert.equal(reset.alreadyReleased, false);
    assert.ok(reset.identity.bindingReleasedAt);
    assert.equal(await BindingAudit.countDocuments({ email }), 1);
    assert.equal((await courseAccess.bindIdentity({ telegramUser: { id: 500 }, email })).reason, 'released_account');
    const rebound = await courseAccess.bindIdentity({ telegramUser: { id: 501, username: 'newbuyer' }, email });
    assert.equal(rebound.ok, true);
    assert.equal(String(rebound.identity._id), String(first.identity._id));
    console.log('PASS: Telegram course access binds the first paid-email account, issues protected join requests, revokes/restores access, and securely releases an email for one replacement account without external calls.');
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
