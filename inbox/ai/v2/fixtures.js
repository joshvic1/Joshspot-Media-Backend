// Offline model doubles only. Never imported by production modules.
function grounding(input){return {segments:input.segments.map(s=>({index:s.index,claims:[{text:s.text,type:'NEUTRAL',sources:[],entailed:true}]})),coverage:input.requestLedger.filter(n=>n.disposition==='PENDING').map(n=>({id:n.id,disposition:input.action==='handoff'?'HANDOFF_REQUIRED':input.allSegments.every(s=>s.kind==='question')?'CLARIFICATION_REQUIRED':'ANSWERED',segments:input.allSegments.map((_,i)=>i),reason:'Controlled test answer'}))};}
module.exports={grounding};
