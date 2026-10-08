// Engine selection is independent of each engine's conversational implementation.
function version(config = {}, env = process.env) {
  // A saved Admin choice wins. The environment is a legacy fallback, not a
  // hidden override that would make the Settings selector ineffective.
  const value = config.engineVersion || env.AI_ENGINE_VERSION || 'v1';
  if (!['v1', 'shadow', 'v2', 'v3', 'v4'].includes(value)) throw new Error('Invalid AI_ENGINE_VERSION');
  if(value==='v4'&&config.mode==='LIVE'&&env.AI_V4_LIVE_APPROVED!=='1')throw new Error('Validate V4 before explicit AI_V4_LIVE_APPROVED=1 approval.');
  return value;
}
module.exports = { version };
