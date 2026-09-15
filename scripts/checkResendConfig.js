require("dotenv").config({ path: require("node:path").join(__dirname, "../.env"), quiet: true });
const { Resend } = require("resend");
(async () => {
  if (!process.env.RESEND_API_KEY) { console.log("RESEND_API_KEY is missing from the backend environment."); process.exitCode = 1; return; }
  const { data, error } = await new Resend(process.env.RESEND_API_KEY).domains.list();
  if (error) {
    const detail = String(error.message || "").replaceAll(process.env.RESEND_API_KEY, "[redacted]").replace(/re_[A-Za-z0-9_-]+/g, "[redacted]");
    console.log(JSON.stringify({ configured: true, domainCheck: "unavailable", errorType: error.name, statusCode: error.statusCode, detail })); return;
  }
  console.log(JSON.stringify({ configured: true, domains: data.data.map(({ name, status }) => ({ name, status })) }));
})().catch(() => { console.log("Unable to connect to Resend to check sender domains."); process.exitCode = 1; });
