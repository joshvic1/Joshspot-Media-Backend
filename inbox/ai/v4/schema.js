const str=(max=2000)=>({type:'string',maxLength:max});
const en=(...values)=>({type:'string',enum:values});
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const arr=(items,maxItems=12)=>({type:'array',items,maxItems});
const nil=s=>({anyOf:[s,{type:'null'}]});
const num={type:'number',minimum:0.01,maximum:100000000};
const days={type:'integer',minimum:1,maximum:365};
const platforms=['TIKTOK','META','FACEBOOK','INSTAGRAM','UNKNOWN'];
const services=['ACCOUNT_SETUP','ADS_MANAGEMENT','COURSE','GENERAL_SUPPORT','UNKNOWN'];
const requests=['ASK_PRICE','ASK_QUOTE','ASK_RECOMMENDATION','ASK_BREAKDOWN','ASK_REQUIREMENTS','ASK_SERVICE_INCLUSIONS','ASK_EXPECTED_RESULTS','ASK_CREATIVE_REQUIREMENTS','ASK_TECHNICAL_HELP','ASK_COURSE_DETAILS','ASK_PAYMENT_DETAILS','CLAIM_PAYMENT','REQUEST_HUMAN','NEGOTIATE','OTHER'];
const fields=['service','platform','budget','budget_basis','duration','package','allocation','proceed','payment','clarification'];
const evidence=obj({messageId:str(160),text:str(6000)});
const pair={platform:en(...platforms),service:en(...services)};
const selection=obj({...pair,evidence});
const interpreter=obj({
 current_requests:arr(obj({id:str(80),type:en(...requests),...pair,evidence})),
 facts:arr(obj({...pair,budget:nil(obj({amount:num,basis:en('DAILY_AD_SPEND','TOTAL_AD_SPEND','ALL_IN_MAXIMUM','PACKAGE','COUNTEROFFER','UNKNOWN'),currency:en('NGN')})),duration_days:nil(days),package_duration_days:nil(days),evidence})),
 purchase_change:obj({operation:en('KEEP','ADD','REPLACE','REMOVE','NONE'),items:arr(selection,4),evidence:nil(evidence)}),
 readiness:obj({value:en('EXPLORING','INTERESTED','READY_TO_PAY','DEFERRED','DECLINED','UNKNOWN'),evidence:nil(evidence)}),
 whole_purchase_cap:nil(obj({amount:num,currency:en('NGN'),evidence})),
 knowledge_needs:arr(obj({topic:en(...requests),...pair,query:str(400)})),
 clarification:obj({needed:{type:'boolean'},reason:str(500),missing_fields:arr(en(...fields),8)})
});
const composer=obj({message:str(6000),covered_request_ids:arr(str(80)),unsupported_request_ids:arr(str(80)),questions_asked:arr(obj({purpose:str(200),field:en(...fields)}),6)});
function valid(s,v){
 if(s.anyOf)return s.anyOf.some(x=>valid(x,v));
 if(s.enum)return s.enum.includes(v);
 if(s.type==='null')return v===null;
 if(s.type==='object')return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>k in s.properties)&&s.required.every(k=>Object.hasOwn(v,k)&&valid(s.properties[k],v[k]));
 if(s.type==='array')return Array.isArray(v)&&v.length<=s.maxItems&&v.every(x=>valid(s.items,x));
 if(s.type==='string')return typeof v==='string'&&v.length<=s.maxLength;
 if(s.type==='boolean')return typeof v==='boolean';
 return typeof v==='number'&&Number.isFinite(v)&&(s.type!=='integer'||Number.isInteger(v))&&v>=s.minimum&&v<=s.maximum;
}
module.exports={interpreter,composer,valid,platforms,services,requests,fields};
