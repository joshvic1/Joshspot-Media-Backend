const {evidenced}=require('./state');
const informational=new Set(['ask_price','ask_requirements','ask_recommendation','ask_budget_advice','ask_duration','ask_payment_method','ask_course_question','ask_support_question','other_supported_business_question']);
function build(i,context){
 const needs=[...(i.requests||[])];
 for(const [key,type]of [['questions','other_supported_business_question'],['recommendations','ask_recommendation']])for(const q of i[key]||[])if(!needs.some(n=>n.evidence?.text===q.evidence?.text&&n.text===q.text))needs.push({...q,id:`${key}-${needs.length}`,type,itemId:'',questionId:''});
 const seen=new Set();return needs.filter(n=>evidenced(n.evidence,context)).map((n,index)=>{const id=n.id&&!seen.has(n.id)?n.id:`need-${index}`;seen.add(id);return {...n,id,disposition:'PENDING'};});
}
function assertComplete(ledger){if(ledger.some(n=>n.disposition==='PENDING'||!n.disposition))throw new Error('Unresolved customer request');}
module.exports={build,informational,assertComplete};
