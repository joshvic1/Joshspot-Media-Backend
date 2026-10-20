const { Conversation, Notification, Message } = require('./models');
const mongoose = require('mongoose');
const live = require('./live');

// The schedule has its own stable ID, so retries cannot duplicate an alert.
async function tick() {
  // Older schedules did not save their creator; recover only from the actual
  // scheduling activity, never assume the current assignee created it.
  const legacy = await Conversation.find({ status:'follow_up', deleting:{$ne:true}, followUpAt:{$lte:new Date(),$ne:null}, followUpBy:null }).limit(25).lean();
  for (const row of legacy) {
    const stamp = `Follow-up scheduled for ${new Date(row.followUpAt).toISOString()}`;
    const activity = await Message.findOne({conversation:row._id,type:'activity',direction:'internal',text:{$regex:stamp.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}}).sort({_id:-1}).lean();
    const creator = activity?.author === 'admin' ? require('./adminIdentity').ID : activity?.author;
    if (creator && mongoose.isValidObjectId(creator)) await Conversation.updateOne({_id:row._id,followUpBy:null,followUpAt:row.followUpAt},{$set:{followUpBy:creator,followUpAlertId:new mongoose.Types.ObjectId(),followUpNotifiedAt:null}});
  }
  const rows = await Conversation.find({
    status: 'follow_up', deleting: { $ne: true },
    followUpAt: { $lte: new Date(), $ne: null }, followUpBy: { $ne: null },
    followUpAlertId: { $ne: null }, followUpNotifiedAt: null,
  }).sort({ followUpAt: 1 }).limit(50).lean();
  for (const row of rows) {
    const schedule = { _id: row._id, status: 'follow_up', deleting: { $ne: true }, followUpAlertId: row.followUpAlertId, followUpAt: row.followUpAt };
    if (!await Conversation.exists(schedule)) continue;
    await Notification.updateOne({ recipient: row.followUpBy, message: row.followUpAlertId }, {
      $setOnInsert: { kind: 'followup', conversation: row._id, authorName: 'Follow-up reminder' },
    }, { upsert: true });
    // A reschedule/cancellation racing this worker must not leave a stale alert.
    const updated = await Conversation.updateOne(schedule, { $set: { followUpNotifiedAt: new Date() } });
    if (!updated.matchedCount) await Notification.deleteOne({ recipient: row.followUpBy, message: row.followUpAlertId });
    live.notify();
  }
}
module.exports = { tick };
