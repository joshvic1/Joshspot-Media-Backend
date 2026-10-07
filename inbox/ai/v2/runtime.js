function version(config){
  const value=process.env.AI_ENGINE_VERSION||config.engineVersion||'v1';
  if(!['v1','shadow','v2'].includes(value))throw new Error('Invalid AI_ENGINE_VERSION');
  // Explicit operational gate: shadow/test success never auto-enables live actions.
  if(value==='v2'&&config.mode==='LIVE'&&process.env.AI_V2_LIVE_APPROVED!=='1')throw new Error('V2 LIVE requires controlled validation and AI_V2_LIVE_APPROVED=1');
  return value;
}
module.exports={version};
