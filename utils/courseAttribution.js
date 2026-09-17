const sources = new Set(["tiktok", "instagram", "facebook", "whatsapp", "google", "snapchat", "youtube", "direct", "other", "unknown"]);
const browsers = new Set(["tiktok", "instagram", "facebook", "whatsapp", "snapchat", "chrome", "safari", "edge", "firefox", "opera", "samsung", "in-app", "unknown"]);
const methods = new Set(["tag", "referrer", "click-id", "none"]);
module.exports = (input) => ({
  source: sources.has(input?.source) ? input.source : "unknown",
  ...(input?.method === "tag" && typeof input?.sourceLabel === "string" ? { sourceLabel: input.sourceLabel.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) } : {}),
  browser: browsers.has(input?.browser) ? input.browser : "unknown",
  method: methods.has(input?.method) ? input.method : "none",
});
