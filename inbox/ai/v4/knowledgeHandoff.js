async function handoff({requests,next,pack,ports,simulation,operations}) {
 await ports.assertCurrent();
 const reason='NO_APPROVED_KNOWLEDGE';
 const summary=`Approved information unavailable for: ${requests.map(r=>r.type).join(', ')}. Review the customer question and preserved V4 purchase context.`;
 const result=simulation?{accepted:true,simulation:true,reason}:await ports.handoff({reason,summary});
 if(!result.accepted&&!result.pending)throw new Error('V4_HANDOFF_NOT_ACCEPTED');
 next.ownership='HUMAN';next.unresolvedRequests=requests;
 pack.unresolvedRequests=requests;pack.actions.handoff=result;pack.allowedQuestions=[];
 operations.push('handoff:NO_APPROVED_KNOWLEDGE');
}
module.exports={handoff};
