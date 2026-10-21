// V1 delivery backstop. Only successful AI sends are evidence of repetition.
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}\s:/?.=&%-]/gu, ' ').replace(/\s+/g, ' ').trim();
function asksForRepeat(text) {
  const value = normalize(text);
  if (/\b(?:don t|dont|do not|stop)\s+(?:resend|repeat|repeating|sending)\b/.test(value)) return false;
  return /^(?:repeat|explain again)\b|\bbreak (?:it|that|this) down\b|\b(?:can|could) you explain (?:it|that|this)\b|\b(?:resend|re explain)\b|\b(?:send|share|explain|repeat|say|break|go over)\b.{0,65}\b(?:again|once more|one more time)\b|\b(?:please|pls|abeg|can you|could you)\s+(?:repeat|explain again)\b|\b(?:what do you mean|i don t understand|i dont understand|i didn t understand|i no understand|explain (?:it|that|this) (?:better|more|further))\b/.test(value);
}
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // Never treat a changed price, duration or URL as the same information.
  const values = text => (text.match(/https?:\S+|\d+(?:[.,]\d+)*/g) || []).sort().join('|');
  if (values(a) !== values(b)) return false;
  const left = a.split(' '), right = b.split(' ');
  if (Math.min(left.length, right.length) < 8) return false;
  const pairs = words => new Set(words.slice(1).map((word, i) => words[i] + ' ' + word));
  const x = pairs(left), y = pairs(right);
  const overlap = [...x].filter(pair => y.has(pair)).length;
  return 2 * overlap / (x.size + y.size) >= 0.9;
}
function protect(result, text, history) {
  if (result.action !== 'reply' || !result.response || asksForRepeat(text)) return result;
  const candidate = normalize(result.response);
  const match = history.find(message => message.direction === 'outbound' && ['sent', 'delivered', 'read'].includes(message.status) &&
    (message.author === 'ai' || message.automation?.engineVersion) && !message.automation?.followup && !message.automation?.handoff && similar(candidate, normalize(message.text)));
  if (!match) return result;
  return { ...result, action: 'handoff', handoff: 'AI_REPEATED_RESPONSE', handoffTeam: 'SS', response: '', suppressAcknowledgement: true,
    summary: 'AI handed off to avoid repeating a previously sent response. Please review the customer’s latest message.',
    debug: { ...result.debug, repetition: { matchedMessageId: String(match._id), reason: 'Previously sent AI response', originalAction: result.action } },
    state: { ...result.state, aiActive: false, humanHandoffReason: 'AI_REPEATED_RESPONSE', nextObjective: 'HANDOFF' } };
}
module.exports = { protect, asksForRepeat, normalize, similar };
