function version(config){
  const value=process.env.AI_ENGINE_VERSION||config.engineVersion||'v1';
  if(!['v1','shadow','v2'].includes(value))throw new Error('Invalid AI_ENGINE_VERSION');
  return value;
}
module.exports={version};
