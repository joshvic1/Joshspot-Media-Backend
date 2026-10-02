const axios = require('axios');
const required = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_GRAPH_VERSION'];
function configuration() {
  const missing = required.filter((key) => !process.env[key]);
  if (process.env.WHATSAPP_GRAPH_VERSION && !/^v\d+\.\d+$/.test(process.env.WHATSAPP_GRAPH_VERSION)) missing.push('WHATSAPP_GRAPH_VERSION (use vNN.0)');
  return { configured: missing.length === 0, missing };
}
function api() {
  if (!configuration().configured) throw Object.assign(new Error('WhatsApp is not configured. Contact your administrator.'), { status: 503 });
  return axios.create({ baseURL: `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION}`, timeout: 20000, headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } });
}
async function send(to, message) {
  const data = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: message.type, biz_opaque_callback_data: `${message._id}:${message.attempts}` };
  if (message.type === 'text') data.text = { body: message.text };
  else if (message.type === 'template') data.template = message.providerPayload;
  else if (['image', 'document'].includes(message.type)) data[message.type] = { id: message.media.id, ...(message.text ? { caption: message.text } : {}), ...(message.type === 'document' ? { filename: message.media.name } : {}) };
  else throw Object.assign(new Error('This message type cannot be sent.'), { status: 400 });
  const response = await api().post(`/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, data);
  if (!response.data.messages?.[0]?.id) throw new Error('No delivery identifier returned');
  return response.data.messages[0].id;
}
async function templates() {
  const results = []; let after;
  do {
    const { data } = await api().get(`/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`, { params: { fields: 'id,name,language,category,status,components', limit: 100, ...(after ? { after } : {}) } });
    results.push(...data.data);
    after = data.paging?.next ? data.paging.cursors?.after : null;
    if (results.length > 10000) throw new Error('Template catalogue exceeds sync limit');
  } while (after);
  return results;
}
async function upload(buffer, mime, name) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp'); form.append('file', new Blob([buffer], { type: mime }), name);
  const { data } = await api().post(`/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`, form);
  return data.id;
}
async function download(id) {
  const client = api();
  const { data } = await client.get(`/${encodeURIComponent(id)}`, { params: { phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID } });
  const url = new URL(data.url);
  if (url.protocol !== 'https:' || !['lookaside.fbsbx.com', 'lookaside.facebook.com'].includes(url.hostname)) throw new Error('Untrusted media host');
  const response = await axios.get(url.href, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }, responseType: 'arraybuffer', timeout: 20000, maxContentLength: 20 * 1024 * 1024, maxRedirects: 0 });
  return { buffer: response.data, mime: data.mime_type };
}
module.exports = { configuration, send, templates, upload, download };
