// Course references never rewrite an existing service quote or invoice.
function classifyLegacy(text,state={},decision={}) {
 const t=text.toLowerCase();
 const course=!/\bof course\b/.test(t)&&/\b(?:course|video training|video tutorial|training video)\b/.test(t);
 const learning=/\b(?:learn|learning|teach me|training|tutorial)\b/.test(t)&&/\b(?:ads?|advertising|tiktok|facebook|instagram)\b/.test(t);
 const eight=/\b(?:8\s*k|8[,.]?000|eight thousand)\b/.test(t);
 const budget=/\b(?:budget|daily|per day|ad spend)\b/.test(t);
 const bargain=/\b(?:can you|could you|accept|do it for|reduce|negotia|discount)\b/.test(t);
 const adReference=/\b(?:advert|advertisement|offer|saw|advertised|promo)\b/.test(t);
 const reference=eight&&!budget&&(!bargain||adReference)&&(/\?|\b(?:what about|you said|only|saw)\b/.test(t)||adReference);
 const rejecting=/\b(?:don't want|do not want|not interested in|not the)\s+(?:the\s+)?(?:course|training|video)/.test(t);
 if(rejecting)return null;
 if(course)return {kind:'course',select:/\b(?:want|buy|purchase|get|prefer|choose|instead|interested)\b/.test(t)&&!/^\s*(?:what|is|does|how)\b/.test(t)};
 if(reference)return {kind:'reference',select:false};
 const setupContext=state.serviceType==='account_setup'||state.lastRequiredQuestion==='GET_SERVICE_TYPE';
 if(learning&&!setupContext&&!/\b(?:set up|setup|run.*for me)\b/.test(t))return {kind:'learning',select:true};
 if(eight&&!budget&&!bargain&&!state.budget)return {kind:'clarify',select:false};
 if(!budget&&!bargain&&['reference','purchase','learning','clarify'].includes(decision.courseRequest)&&(!setupContext||!['learning'].includes(decision.courseRequest)))return {kind:decision.courseRequest,select:['purchase','learning'].includes(decision.courseRequest)};
 if(state.purchasePath==='course'&&/^(?:yes|okay|ok|send (?:the )?(?:link|account)|how (?:do|can) i pay)[.!?\s]*$/.test(t))return {kind:'course',select:true};
 return null;
}
function classify(text,state={},decision={}) {
 const t=String(text).toLowerCase();
 const whatsapp=/\bwhats\s*app\b/.test(t);
 const destination=/\b(?:facebook|instagram|meta)\b/.test(t)&&/\b(?:messages?|inbox|send|direct|click)\b/.test(t);
 const reject=/\b(?:don.t want|do not want|not interested in)\b/.test(t);
 if(whatsapp&&!destination&&!reject&&/\b(?:status|ads?|adverts?|course|training|learn|tutorial)\b/.test(t))
  return {kind:'course',select:false,courseKey:'whatsapp_status_course'};
 const result=classifyLegacy(text,state,decision);
 return result ? {...result,courseKey:'ads_video_course'} : null;
}
module.exports={classify};
