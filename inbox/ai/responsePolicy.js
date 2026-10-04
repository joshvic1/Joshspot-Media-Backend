// A promise of human follow-up is an action, never a completed ordinary answer.
function promisesHandoff(text,fallback='') {
 const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
 return Boolean(text && ((fallback && normalize(text)===normalize(fallback)) || /\b(?:hold on|please wait|response shortly|respond shortly|(?:team|agent|representative|staff|someone).{0,45}(?:get back|contact you|respond|reply|assist you)|(?:pass|transfer|connect|assign|refer|escalat)\w*.{0,35}(?:team|agent|representative|staff|human))\b/i.test(text)));
}
module.exports={promisesHandoff};
