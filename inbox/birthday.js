const mongoose = require('mongoose');
const { Control } = require('./earnings/models');

// Lagos is UTC+1 all year. These UTC timestamps cover 12:00 AM–11:59:59 PM
// on Friday, 30 October 2026 in Africa/Lagos.
const celebration = Object.freeze({
  id: 'okolosi-marvel-2026-10-30',
  startsAt: new Date('2026-10-29T23:00:00.000Z'),
  endsAt: new Date('2026-10-30T23:00:00.000Z'),
});

// This is deliberately an account ID, rather than the CSS role or a display name.
const customerSupportStaffId = '6a4fa5d7bf99d3294e4f2258';

const completionSchema = new mongoose.Schema({
  celebration: { type: String, required: true },
  employee: { type: String, required: true },
  completedAt: { type: Date, required: true },
}, { timestamps: true });
completionSchema.index({ celebration: 1, employee: 1 }, { unique: true });
const Completion = mongoose.models.InboxBirthdayCompletion || mongoose.model('InboxBirthdayCompletion', completionSchema);

const isActive = (now = new Date()) => +now >= +celebration.startsAt && +now < +celebration.endsAt;
const isAuthorized = (actor) => Boolean(actor?.admin || String(actor?.id || '') === customerSupportStaffId);
const employeeId = (actor) => actor?.admin ? 'admin' : String(actor?.id || '');

// The mandatory card is short. This record removes up to five minutes from the
// authorised CSS staff member's response-time calculation, then completion ends
// the protection immediately. It neither changes availability nor break allowance.
async function protectInitialViewing(actor, now = new Date()) {
  if (actor?.admin || String(actor?.id) !== customerSupportStaffId) return;
  const to = new Date(Math.min(+now + 5 * 60 * 1000, +celebration.endsAt));
  await Control.findOneAndUpdate(
    { staff: String(actor.id), kind: 'birthday', celebration: celebration.id },
    { $setOnInsert: { staff: String(actor.id), kind: 'birthday', celebration: celebration.id, from: now, to, at: now, by: 'system', reason: 'Birthday celebration' } },
    { upsert: true, returnDocument: 'after' },
  );
}

async function status(actor, now = new Date()) {
  const available = isActive(now);
  const authorized = available && isAuthorized(actor);
  if (!authorized) return { available, authorized: false, celebration: celebration.id };
  const employee = employeeId(actor);
  const completed = await Completion.findOne({ celebration: celebration.id, employee }).select('completedAt').lean();
  if (!completed) await protectInitialViewing(actor, now);
  return { available: true, authorized: true, celebration: celebration.id, initialCompletedAt: completed?.completedAt || null };
}

async function complete(actor, now = new Date()) {
  if (!isActive(now) || !isAuthorized(actor)) {
    const error = new Error('This birthday celebration is not available.');
    error.status = 404;
    throw error;
  }
  const employee = employeeId(actor);
  const completed = await Completion.findOneAndUpdate(
    { celebration: celebration.id, employee },
    { $setOnInsert: { celebration: celebration.id, employee, completedAt: now } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  if (!actor.admin && employee === customerSupportStaffId) {
    await Control.updateMany(
      { staff: employee, kind: 'birthday', celebration: celebration.id, to: { $gt: now } },
      { $set: { to: now } },
    );
  }
  return { available: true, authorized: true, celebration: celebration.id, initialCompletedAt: completed.completedAt };
}

module.exports = { celebration, customerSupportStaffId, isActive, isAuthorized, status, complete };
