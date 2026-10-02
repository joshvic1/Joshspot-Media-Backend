const crypto = require('node:crypto');

function phone(value) {
  let digits = String(value || '').trim().replace(/[\s().-]/g, '');
  if (/^0[789]\d{9}$/.test(digits)) digits = `234${digits.slice(1)}`;
  if (digits.startsWith('00')) digits = digits.slice(2);
  digits = digits.replace(/^\+/, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw Object.assign(new Error('Enter a valid international phone number, including country code.'), { status: 400 });
  return digits;
}
const windowOpen = (lastInboundAt, now = Date.now()) => Boolean(lastInboundAt && now - new Date(lastInboundAt).getTime() < 86400000);
const visible = (actor) => actor.admin ? {} : { $or: [{ assignedTo: null }, { assignedTo: actor.id }] };
const canReply = (actor, conversation) => actor.admin || String(conversation.assignedTo) === actor.id;
function signature(raw, header, secret) {
  if (!secret || !Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(header || '')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}
function templateFields(template) {
  const fields = [];
  for (const component of template.components || []) {
    if (!['HEADER', 'BODY', 'FOOTER'].includes(component.type) || (component.type === 'HEADER' && component.format !== 'TEXT')) return null;
    const variables = [...new Set([...String(component.text || '').matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]))];
    if (variables.some((v, i) => v !== String(i + 1))) return null;
    variables.forEach((key) => fields.push({ key: `${component.type.toLowerCase()}.${key}`, component: component.type.toLowerCase(), position: key }));
  }
  return fields;
}
function templatePayload(template, values) {
  const fields = templateFields(template);
  if (template.status !== 'APPROVED' || !fields) throw Object.assign(new Error('Choose an approved text template supported by this inbox.'), { status: 400 });
  const components = [];
  for (const field of fields) {
    const text = values?.[field.key];
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw Object.assign(new Error('Fill in every template variable (maximum 500 characters each).'), { status: 400 });
    let component = components.find((item) => item.type === field.component);
    if (!component) { component = { type: field.component, parameters: [] }; components.push(component); }
    component.parameters.push({ type: 'text', text: text.trim() });
  }
  const preview = (template.components || []).map((c) => String(c.text || '').replace(/\{\{(\d+)\}\}/g, (_, key) => values[`${c.type.toLowerCase()}.${key}`] || '')).filter(Boolean).join('\n');
  return { payload: { name: template.name, language: { code: template.language }, components }, preview };
}
const ranks = { queued: 0, sending: 1, unknown: 1, sent: 2, delivered: 3, read: 4, failed: -1 };
const statusCanAdvance = (current, next) => next === 'failed' ? !['delivered', 'read', 'failed'].includes(current) : current === 'failed' && next === 'sent' ? false : (ranks[next] ?? -1) > (ranks[current] ?? -1);
module.exports = { phone, windowOpen, visible, canReply, signature, templateFields, templatePayload, statusCanAdvance };
