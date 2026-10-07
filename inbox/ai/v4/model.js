const axios=require('axios'),schemas=require('./schema'),prompts=require('./prompts');
// Official model pages checked 2026-10-07, standard USD / 1M text tokens.
const rates={'gpt-6.1-sol':[2,.1,10,2.5],'gpt-6-luna':[.1,.01,.5,.125]};
function estimate(model,u){const r=rates[model];if(!r)return null;const cached=u.input_tokens_details?.cached_tokens||0,writes=u.input_tokens_details?.cache_write_tokens||0;return ((Math.max(0,(u.input_tokens||0)-cached-writes))*r[0]+cached*r[1]+(u.output_tokens||0)*r[2]+writes*r[3])/1e6;}
function client({config,reserve=async()=>{},transport=axios}){
 return {async pass(stage,input,repair=null){
  const model=config[stage==='interpreter'?'v4InterpreterModel':'v4ComposerModel'];
  if(!model||!process.env.OPENAI_API_KEY)throw new Error('V4_NOT_CONFIGURED');
  const effort=config[stage==='interpreter'?'v4InterpreterReasoning':'v4ComposerReasoning']||'medium';
  const schema=schemas[stage],start=Date.now();await reserve();
  const body={model,store:false,reasoning:{effort},max_output_tokens:config.v4MaxOutputTokens||4000,instructions:prompts[stage],text:{format:{type:'json_schema',name:`joshspot_v4_${stage}`,strict:true,schema}},input:[{role:'user',content:JSON.stringify(input)},...(repair?[{role:'developer',content:JSON.stringify({repair})}]:[])]};
  let data;try{({data}=await transport({method:'POST',url:'https://api.openai.com/v1/responses',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},data:body,timeout:45000}));}catch(e){throw Object.assign(new Error('V4_PROVIDER_ERROR'),{code:e.response?.data?.error?.code,status:e.response?.status,metrics:{stage,model,latencyMs:Date.now()-start,providerError:true,estimated_cost_usd:null}});}
  const metrics={stage,model,latencyMs:Date.now()-start,...data.usage,cached_input_tokens:data.usage?.input_tokens_details?.cached_tokens||0,estimated_cost_usd:estimate(model,data.usage||{})};
  if(data.status!=='completed')throw Object.assign(new Error('V4_INCOMPLETE_RESPONSE'),{metrics});
  const text=(data.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
  let value;try{value=JSON.parse(text);}catch{throw Object.assign(new Error('V4_INVALID_STRUCTURED_OUTPUT'),{metrics});}
  if(!schemas.valid(schema,value))throw Object.assign(new Error('V4_INVALID_STRUCTURED_OUTPUT'),{metrics});
  return {value,metrics};
 }};
}
module.exports={client,estimate,rates};
