const { EventEmitter } = require('node:events');
const mongoose = require('mongoose');
const bus = new EventEmitter(); bus.setMaxListeners(0);
let watching = false; let pending;
function notify() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; bus.emit('change'); }, 1500);
  pending.unref();
}
// One database change stream per backend process, not one database poll per browser.
// Replica sets (including Atlas) support this; clients also reconcile periodically.
function start() {
  if (watching || mongoose.connection.readyState !== 1) return;
  watching = true;
  const stream = mongoose.connection.db.watch([{ $match: { 'ns.coll': { $in: ['inboxmessages', 'inboxconversations', 'inboxcontacts', 'inboxnotifications'] } } }]);
  stream.on('change', notify);
  stream.on('error', () => { stream.close().catch(() => {}); const retry = setTimeout(() => { watching = false; start(); }, 60000); retry.unref(); });
}
module.exports = { bus, notify, start };
