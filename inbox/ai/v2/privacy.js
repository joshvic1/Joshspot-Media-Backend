// Redaction identifies credential-shaped spans, never customer intent. Do not clip.
function redact(text){
  return String(text??'')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|EAA[A-Za-z0-9_-]{16,})\b/g,'[credential removed]')
    .replace(/\b(password|passcode|otp|cvv|access token|api key|pin)\s*(?:is\s+|[:=]\s*)(["'])(.*?)\2/gi,'$1: [credential removed]')
    .replace(/\b(password|passcode|otp|cvv|access token|api key|pin)\s*(?:is\s+|[:=]\s*)["']?([^\s"',;]+)/gi,'$1: [credential removed]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email removed]')
    .replace(/(?<!\w)\+?\d[\d -]{9,}\d(?!\w)/g,'[private number removed]');
}
module.exports={redact};
