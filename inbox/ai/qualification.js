// Require customer language/context, not a model's confidence flag, for sales choices.
function platforms(text, state, decision) {
  const hasTikTok=/\btik\s*tok\b/i.test(text), hasMeta=/\b(?:meta|facebook|instagram|fb|ig)\b/i.test(text);
  const options=[];
  if(hasTikTok&&!/\b(?:not|no|don't want|do not want)\s+(?:on\s+)?tik\s*tok\b/i.test(text))options.push('tiktok');
  if(hasMeta&&!/\b(?:not|no|isn't|is not|don't want|do not want)\s+(?:on\s+)?(?:meta|facebook|instagram)\b/i.test(text))options.push('meta');
  if(state.lastRequiredQuestion==='GET_PLATFORM') {
    if(/^(?:all(?: of them)?|both(?: of them)?)(?: please)?[.!\s]*$/i.test(text.trim()))return ['tiktok','meta'];
    if(/^(?:the )?first(?: one| option)?[.!\s]*$/i.test(text.trim()))return ['tiktok'];
    if(/^(?:the )?second(?: one| option)?[.!\s]*$/i.test(text.trim()))return ['meta'];
  }
  if(options.length===1)return options;
  return (decision.platforms||[decision.platform]).filter(p=>options.includes(p));
}
function serviceChoice(text,state) {
  const t=text.trim();
  if(state.lastRequiredQuestion==='GET_SERVICE_TYPE') {
    const option=t.match(/^(?:(?:i(?:'ll| will)?\s+(?:choose|pick|take|prefer)|let'?s (?:do|go with))\s+)?(?:the\s+)?(?:(?:option|number|no\.?)\s*(one|two|1|2)|(first|second|one|two|1|2)(?:\s+(?:one|option))?)(?:\s+please)?[.!\s]*$/i);
    if(option)return /^(?:one|1|first)$/i.test(option[1]||option[2])?'account_setup':'ads_management';
    if(/^(?:the )?(?:first|1)(?: one| option)?[.!\s]*$/i.test(t)||/^(?:setup|account setup|set\s*up|teach me|run (?:it|them|ads) myself)[.!\s]*$/i.test(t))return 'account_setup';
    if(/^(?:the )?(?:second|2)(?: one| option)?[.!\s]*$/i.test(t)||/^(?:management|ads management|manage it|run (?:it|them|ads) for me)[.!\s]*$/i.test(t))return 'ads_management';
  }
  if(/^actually\s+(?:manage|run)\b/i.test(t))return 'ads_management';
  if(/\b(?:don't|do not|not sure|what is|what does|difference|both|compare)\b/i.test(t))return null;
  if(/\b(?:set\s*up|setup)\b/i.test(t) && /\b(?:i (?:want|need|would like|like|prefer|choose)|(?:can|could) you|please|how much|price|cost|send (?:the )?account)\b/i.test(t))return 'account_setup';
  if(/\b(?:you|your team)\b.{0,40}\b(?:run|manage|handle)\b.{0,50}\b(?:for me|for us|my (?:ads|campaign))\b/i.test(t)||/\b(?:i (?:want|need|would like)|please)\b.{0,35}\b(?:ads management|manage my (?:ads|campaign))\b/i.test(t))return 'ads_management';
  return null;
}
module.exports={platforms,serviceChoice};
