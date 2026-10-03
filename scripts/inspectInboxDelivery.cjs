// Read-only diagnostic. Never prints tokens, URIs, message text or full phone numbers.
require('dotenv').config({ path: require('node:path').join(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
async function main() {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const since = new Date(Date.now() - 3 * 86400000);
  const jobs = db.collection('inboxwebhookjobs'); const messages = db.collection('inboxmessages');
  const counts = await jobs.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$state', count: { $sum: 1 }, latest: { $max: '$createdAt' } } }]).toArray();
  const backlog = await jobs.find({ state: { $in: ['pending', 'processing', 'dead'] } }, { projection: { state: 1, attempts: 1, createdAt: 1, leaseUntil: 1, error: 1, payload: 1 } }).sort({ createdAt: -1 }).limit(25).toArray();
  console.log(JSON.stringify({ type: 'webhookSummary', counts, backlog: backlog.map(j => ({ id: j._id, state: j.state, attempts: j.attempts, createdAt: j.createdAt, leaseUntil: j.leaseUntil, error: j.error, entries: (j.payload?.entry || []).flatMap(e => (e.changes || []).map(c => ({ field: c.field, configuredPhoneMatches: String(c.value?.metadata?.phone_number_id) === process.env.WHATSAPP_PHONE_NUMBER_ID, messages: c.value?.messages?.length || 0, statuses: c.value?.statuses?.length || 0, types: (c.value?.messages || []).map(m => m.type) }))) })) }));
  console.log(JSON.stringify({ type: 'storedMessages', hourly: await messages.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { hour: { $dateToString: { date: '$createdAt', format: '%Y-%m-%dT%H:00Z' } }, direction: '$direction', status: '$status' }, count: { $sum: 1 } } }, { $sort: { '_id.hour': -1 } }, { $limit: 45 }]).toArray(), failed: await messages.find({ status: { $in: ['failed', 'unknown'] }, createdAt: { $gte: since } }, { projection: { error: 1, createdAt: 1, attemptedAt: 1, status: 1 } }).sort({ createdAt: -1 }).limit(10).toArray() }));
  await mongoose.disconnect();
  if (process.env.WHATSAPP_ACCESS_TOKEN) {
    for (const [kind, path] of [['localTokenPhoneCheck', `${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=id`], ['localWabaSubscriptions', `${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`]]) {
      const r = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION}/${path}`, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(15000) });
      const data = await r.json(); console.log(JSON.stringify({ type: kind, status: r.status, code: data.error?.code, subcode: data.error?.error_subcode, errorType: data.error?.type, success: Boolean(data.id), apps: data.data?.map(a => ({ id: a.whatsapp_business_api_data?.id, name: a.whatsapp_business_api_data?.name })) }));
    }
  }
}
main().catch(e => { console.error(JSON.stringify({ failed: true, name: e.name, code: e.code || null })); process.exitCode = 1; }).finally(() => mongoose.disconnect());
