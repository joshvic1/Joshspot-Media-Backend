// Local development often points at the production database. Reading the Inbox
// must never implicitly start another consumer of production delivery jobs.
function workerEnabled(env = process.env) {
  if (env.INBOX_WORKER_ENABLED === 'false') return false;
  if (env.INBOX_WORKER_ENABLED === 'true') return true;
  return Boolean(env.RAILWAY_ENVIRONMENT_ID || env.NODE_ENV === 'production');
}
module.exports = { workerEnabled };
