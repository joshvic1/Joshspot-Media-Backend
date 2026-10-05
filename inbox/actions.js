const express = require('express');
const { randomUUID, createHash } = require('node:crypto');
const { Contact, Conversation, Message } = require('./models');
const { QuickReply, Action, maskPhone } = require('./shortcuts');
const Invoice = require('../models/Invoice');
const policy = require('./policy');
const invoiceService = require('../controllers/invoiceController');
module.exports = ({ wrap, fail, id, conversationFor, rateLimit }) => {
  const router = express.Router();
  const admin = req => { if (!req.actor.admin) fail(403, 'Administrator access required.'); };
  router.get('/quick-replies', wrap(async (req, res) => res.json({ items: await QuickReply.find().select('keyword response updatedAt').sort({ keyword: 1 }).limit(500).lean() })));
  router.post('/quick-replies', wrap(async (req, res) => {
    admin(req); await rateLimit(req);
    const keyword = String(req.body.keyword || '').trim().replace(/^\//, '').toLowerCase();
    const response = req.body.response;
    if (!/^[a-z0-9_-]{1,40}$/.test(keyword) || typeof response !== 'string' || !response.trim() || response.length > 4096) fail(400, 'Use a short keyword and a response of 1–4096 characters.');
    if (!req.body.id && await QuickReply.countDocuments() >= 500) fail(400, 'Up to 500 quick replies are supported.');
    try {
      const item = req.body.id ? await QuickReply.findByIdAndUpdate(id(req.body.id), { keyword, response, updatedBy: req.actor.id }, { new: true }) : await QuickReply.create({ keyword, response, updatedBy: req.actor.id });
      if (!item) fail(404, 'Quick reply not found.'); res.json(item);
    } catch (e) { if (e.code === 11000) fail(409, 'That keyword already exists.'); throw e; }
  }));
  router.delete('/quick-replies/:replyId', wrap(async (req, res) => { admin(req); await QuickReply.deleteOne({ _id: id(req.params.replyId) }); res.json({ ok: true }); }));
  router.get('/admin-contacts', wrap(async (req, res) => {
    admin(req); const q = String(req.query.q || '').slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = { deleting: { $ne: true }, ...(q ? { $or: [{ name: new RegExp(q, 'i') }, { phone: new RegExp(q, 'i') }] } : {}), ...(req.query.before ? { _id: { $lt: id(req.query.before) } } : {}) };
    const rows = await Contact.find(query).select('name phone email status createdAt').sort({ _id: -1 }).limit(21).lean();
    res.json({ items: rows.slice(0, 20), next: rows.length > 20 ? String(rows[19]._id) : null });
  }));
  router.get('/conversations/:id/actions/customer', wrap(async (req, res) => {
    const c = await conversationFor(req); res.json({ name: c.contact.name || 'WhatsApp customer', phone: req.actor.admin ? `+${c.contact.phone}` : maskPhone(c.contact.phone) });
  }));
  router.post('/conversations/:id/actions/payment', wrap(async (req, res) => {
    await rateLimit(req, 30); const c = await conversationFor(req);
    const invoice = await Invoice.findOne({ deletedAt: null, $or: [{ inboxContact: c.contact._id }, { inboxConversation: c._id }, { customerPhone: { $in: [c.contact.phone, `+${c.contact.phone}`] } }] }).sort({ createdAt: -1, _id: -1 });
    if (!invoice) fail(404, 'No invoice found for this customer.');
    let checked; try { checked = await invoiceService.refreshInvoiceStatus(invoice, true); } catch { fail(502, 'Payment provider is unavailable. Try checking again; payment has not been confirmed.'); }
    res.json({ paid: checked.status === 'paid', status: checked.status, amount: checked.amount, checkedAt: new Date() });
  }));
  router.post('/conversations/:id/actions/invoice', wrap(async (req, res) => {
    await rateLimit(req, 20); let c = await conversationFor(req);
    if (!policy.canReply(req.actor, c)) fail(403, 'Claim this conversation before sending an invoice.');
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(req.body.clientId || '')) fail(400, 'A unique request key is required.');
    const amount = Number(req.body.amount); if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000) fail(400, 'Enter a whole naira amount between 100 and 100,000,000.');
    const clientKey = `${req.actor.id}:${c._id}:invoice:${req.body.clientId}`;
    const existing = await Message.findOne({ clientKey }); if (existing) return res.json({ queued: true, messageId: existing._id });
    if (!require('./provider').configuration().configured) fail(503, 'WhatsApp is not connected.');
    if (!policy.windowOpen(c.lastInboundAt)) fail(400, 'The WhatsApp reply window is closed. Ask the customer to reply before sending an invoice.');
    const key = `manual:${c._id}:${req.body.clientId}`;
    let invoice = await Invoice.findOne({ automationKey: key });
    if (invoice && invoice.amount !== amount) fail(409, 'This request was already used for a different amount.');
    if (!process.env.PAYSTACK_SECRET || !/^https:\/\//.test(process.env.CLIENT_URL || '')) fail(503, 'Invoice payments are not configured.');
    await require('./ai/worker').pause(c._id, req.actor, 'HUMAN_REPLY');
    if (!invoice) { try { invoice = await Invoice.create({ automationKey: key, token: randomUUID(), amount, customerName: c.contact.name, customerPhone: c.contact.phone, customerEmail: c.contact.email, inboxContact: c.contact._id, inboxConversation: c._id, note: 'Joshspot Inbox invoice', expiresAt: new Date(Date.now() + 8 * 3600000) }); } catch (e) { if (e.code !== 11000) throw e; invoice = await Invoice.findOne({ automationKey: key }); } }
    if (!invoice.accountNumber) {
      const claimed = await Invoice.findOneAndUpdate({ _id: invoice._id, automationGenerating: { $ne: true }, reference: { $exists: false } }, { $set: { automationGenerating: true } }, { new: true });
      if (!claimed) fail(409, 'Invoice generation is processing or needs review. Do not create another invoice.');
      try { invoice = await invoiceService.generateInvoiceTransfer(claimed); } catch { fail(502, 'Payment account generation needs review before retrying.'); }
    }
    if (!invoice.accountNumber || !invoice.bankName || !invoice.accountName || invoice.status !== 'pending' || invoice.expiresAt < new Date()) fail(409, 'This invoice is not ready for payment.');
    c = await conversationFor(req);
    if (!policy.canReply(req.actor, c) || !policy.windowOpen(c.lastInboundAt)) fail(409, 'Conversation ownership or reply window changed. Invoice retained; no message sent.');
    await require('./ai/worker').pause(c._id, req.actor, 'HUMAN_REPLY');
    const text = `Hello ${c.contact.name || 'there'},\n\nYour invoice: ₦${invoice.amount.toLocaleString('en-NG')}\n\nBank: ${invoice.bankName}\nAccount: ${invoice.accountNumber}\nName: ${invoice.accountName}\n\n${process.env.CLIENT_URL.replace(/\/$/, '')}/pay-invoice/${invoice.token}`;
    let message; try { message = await Message.create({ conversation: c._id, clientKey, direction: 'outbound', type: 'text', text, author: req.actor.id, authorName: req.actor.name, status: 'queued', routingPhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID }); } catch (e) { if (e.code !== 11000) throw e; message = await Message.findOne({ clientKey }); }
    await Conversation.updateOne({ _id: c._id, $or: [{ lastMessageId: { $lt: message._id } }, { lastMessageId: null }] }, { $set: { lastMessageId: message._id, lastMessageAt: message.createdAt, preview: text.slice(0, 160) } });
    res.json({ queued: true, messageId: message._id });
  }));
  const crmKinds = { setup: ['Client', '../controllers/crmController', 'updateClient'], ads: ['AdsClient', '../controllers/adsController', 'updateAdsClient'], verification: ['VerificationClient', '../controllers/verificationController', 'updateVerificationClient'] };
  const crmMatch = c => {
    const n = c.contact.phone.replace(/\D/g, '');
    const variants = [n, '+' + n, ...(n.startsWith('234') ? ['0' + n.slice(3)] : [])];
    return { clientNumber: new RegExp('^(?:' + variants.map(v => [...v].map(ch => ch === '+' ? '\\+' : ch).join('[\\s().-]*')).join('|') + ')$') };
  };
  router.get('/conversations/:id/actions/crm/:kind', wrap(async (req, res) => {
    const c = await conversationFor(req), spec = crmKinds[req.params.kind];
    if (!spec) fail(400, 'Choose Setup, Verification or Ads.');
    const query = crmMatch(c); if (req.query.recordId) query._id = id(req.query.recordId);
    const row = await require('../models/' + spec[0]).findOne(query).sort({createdAt:-1}).lean();
    if (row && req.params.kind !== 'ads' && !req.actor.admin && req.actor.role !== 'SS') delete row.amountPaid;
    res.json({ record: row });
  }));
  router.put('/conversations/:id/actions/crm/:kind/:recordId', wrap(async (req, res) => {
    await rateLimit(req, 20); const c = await conversationFor(req), spec = crmKinds[req.params.kind];
    if (!spec) fail(400, 'Only Setup, Verification and Ads records can be edited.');
    if (!policy.canReply(req.actor, c)) fail(403, 'Claim this conversation before editing a client.');
    const row = await require('../models/' + spec[0]).findOne({...crmMatch(c), _id:id(req.params.recordId)});
    if (!row) fail(404, 'Linked CRM record not found.');
    const fields = ['amountPaid','servicePaidFor','clientLoginDetails','landingPageLogins','landingPageLink','videoLinks','note','idCard', ...(req.params.kind === 'verification' ? ['businessName'] : [])];
    req.body = Object.fromEntries(fields.filter(f => Object.hasOwn(req.body,f)).map(f => [f,req.body[f]]));
    req.params.id = String(row._id); req.staff = {...req.staff,role:req.actor.role};
    await require(spec[1])[spec[2]](req,res);
  }));
  router.post('/conversations/:id/actions/crm/:kind', wrap(async (req, res) => {
    await rateLimit(req, 20); const c = await conversationFor(req);
    if (!policy.canReply(req.actor, c)) fail(403, 'Claim this conversation before adding a client.');
    const kinds = { setup: ['../controllers/crmController', 'createClient'], ads: ['../controllers/adsController', 'createAdsClient'], verification: ['../controllers/verificationController', 'createVerificationClient'] };
    const kind = kinds[req.params.kind]; if (!kind) fail(400, 'Choose Setup, Verification or Ads.');
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(req.body.clientId || '')) fail(400, 'A unique request key is required.');
    const fields = ['businessName', 'amountPaid', 'servicePaidFor', 'clientLoginDetails', 'landingPageLogins', 'landingPageLink', 'videoLinks', 'note', 'idCard'];
    const payload = Object.fromEntries(fields.filter(f => Object.hasOwn(req.body, f)).map(f => [f, req.body[f]]));
    for (const [f, value] of Object.entries(payload)) if (f !== 'idCard' && f !== 'amountPaid' && (typeof value !== 'string' || value.length > 10000)) fail(400, 'Invalid form field.');
    if (payload.amountPaid !== undefined && (!Number.isFinite(Number(payload.amountPaid)) || Number(payload.amountPaid) < 0)) fail(400, 'Enter a valid amount.');
    payload.clientNumber = `+${c.contact.phone}`;
    if (req.params.kind === 'verification') payload.name = c.contact.name || 'WhatsApp customer'; else payload.businessName = c.contact.name || 'WhatsApp customer';
    const existing = req.params.kind !== 'ads' && await require('../models/' + crmKinds[req.params.kind][0]).findOne(crmMatch(c)).select('_id');
    if (existing) return res.json({id:existing._id,saved:true,existing:true});
    const key = req.params.kind === 'ads' ? `${c._id}:${req.body.clientId}` : `inbox-crm:${req.params.kind}:${c.contact.phone}`; const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const Model = require('../models/' + ({ setup: 'Client', ads: 'AdsClient', verification: 'VerificationClient' })[req.params.kind]);
    const prior = await Model.findOne({ inboxRequestKey: key }).select('_id');
    let action = await Action.findOne({ key });
    if (prior && action?.fingerprint === fingerprint && action.kind === req.params.kind) return res.json({ id: prior._id, saved: true });
    if (action) { if (action.fingerprint !== fingerprint || action.kind !== req.params.kind) fail(409, 'Request key already used.'); if (action.state === 'done') return res.json(action.result); fail(409, 'This save is processing or needs review before another attempt.'); }
    try { action = await Action.create({ key, conversation: c._id, kind: req.params.kind, fingerprint, state: 'processing' }); } catch (e) { if (e.code === 11000) fail(409, 'This save is already processing.'); throw e; }
    req.inboxRequestKey = key; req.body = payload; req.staff = { ...req.staff, role: req.actor.role };
    let status = 200, data;
    // Reuse CRM field permissions and the existing ID upload implementation.
    await require(kind[0])[kind[1]](req, { status(code) { status = code; return this; }, json(value) { data = value; return this; } });
    if (status < 400) { const result = { id: data._id, saved: true }; await Action.updateOne({ _id: action._id }, { $set: { state: 'done', result } }); res.status(status).json(result); }
    else { if (status < 500) await Action.deleteOne({ _id: action._id }); res.status(status).json({ message: data.message || 'Unable to save client.' }); }
  }));
  return router;
};
