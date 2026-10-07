require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const { QuickReply, Action } = require('./shortcuts');
const models = {QuickReply, Action, Client:require('../models/Client'), AdsClient:require('../models/AdsClient'), VerificationClient:require('../models/VerificationClient'), ...require('./models'), ...require('./ai/models'), Invoice:require('../models/Invoice')};
models.AIShadowJob=require('./ai/v2/shadow').Job;models.AIShadowMemory=require('./ai/v2/shadow').Memory;
async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  for (const model of Object.values(models)) { await model.createIndexes(); console.log(`Inbox indexes ready: ${model.modelName}`); }
}
main().catch(() => { console.error('Inbox index creation failed. Check database connectivity and existing duplicate records.'); process.exitCode = 1; }).finally(() => mongoose.disconnect());
