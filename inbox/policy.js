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
const visible = (actor) => actor.admin ? {} : { assignedTo: actor.id, 'ai.active': { $ne: true } };
const accessible = (actor) => actor.admin ? {} : { 'ai.active': { $ne: true }, $or: [{ assignedTo: actor.id }, { collaborators: actor.id }] };
const canReply = (actor, conversation) => actor.admin || (conversation.ai?.active !== true && String(conversation.assignedTo) === String(actor.id));
const canNote = (actor, conversation) => canReply(actor, conversation) || (conversation.ai?.active !== true && (conversation.collaborators || []).some(id => String(id) === String(actor.id)));
function signature(raw, header, secret) {
  if (!secret || !Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(header || '')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}
const variablePattern = /\{\{([^}]+)\}\}/g;
const textFields = (component, prefix) => {
  const variables = [...new Set([...String(component.text || '').matchAll(variablePattern)].map(match => match[1].trim()))];
  const numbered = variables.every(value => /^\d+$/.test(value));
  if (numbered && variables.some((value, index) => Number(value) !== index + 1)) return [];
  return variables.map((position) => ({ key: `${prefix}.${position}`, component: prefix.split('.')[0], position, kind: 'text', parameterName: numbered ? null : position }));
};
function templateFields(template) {
  const fields = [];
  for (const component of template.components || []) {
    const type = String(component.type || '').toUpperCase();
    if (type === 'HEADER') {
      const format = String(component.format || 'TEXT').toUpperCase();
      if (format === 'TEXT') fields.push(...textFields(component, 'header'));
      else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) fields.push({ key: 'header.media', component: 'header', kind: 'media', mediaType: format.toLowerCase() });
      else if (format === 'LOCATION') ['latitude', 'longitude', 'name', 'address'].forEach(part => fields.push({ key: `header.location.${part}`, component: 'header', kind: 'location', locationPart: part }));
      continue;
    }
    if (type === 'BODY') { fields.push(...textFields(component, 'body')); continue; }
    if (type !== 'BUTTONS') continue;
    (component.buttons || []).forEach((button, index) => {
      const buttonType = String(button.type || '').toUpperCase();
      const prefix = `button.${index}`;
      if (buttonType === 'FLOW') fields.push({ key: `${prefix}.flow_token`, component: 'button', index, subType: 'flow', kind: 'flow' });
      const source = buttonType === 'URL' ? button.url : buttonType === 'COPY_CODE' ? (button.example?.[0] || button.text) : buttonType === 'QUICK_REPLY' ? button.payload : '';
      const variables = [...new Set([...String(source || '').matchAll(variablePattern)].map(match => match[1].trim()))];
      variables.forEach(position => fields.push({ key: `${prefix}.${buttonType.toLowerCase()}.${position}`, component: 'button', index, subType: buttonType.toLowerCase(), position, kind: 'button', parameterName: /^\d+$/.test(position) ? null : position }));
    });
  }
  return fields;
}
const templateError = message => Object.assign(new Error(message), { status: 400 });
const requiredText = (values, field) => {
  const value = values?.[field.key];
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw templateError(`Fill in ${field.key.replaceAll('.', ' ')} (maximum 500 characters).`);
  return value.trim();
};
function templatePayload(template, values = {}, media = {}) {
  const fields = templateFields(template);
  if (template.status !== 'APPROVED') throw templateError('Choose an approved WhatsApp template.');
  const components = [];
  const add = component => { components.push(component); return component; };
  for (const component of template.components || []) {
    const type = String(component.type || '').toUpperCase();
    if (type === 'HEADER' || type === 'BODY') {
      const prefix = type.toLowerCase(); const matching = fields.filter(field => field.component === prefix);
      if (!matching.length) continue;
      const mediaField = matching.find(field => field.kind === 'media');
      if (mediaField) {
        const item = media[mediaField.key];
        if (!item?.id || item.type !== mediaField.mediaType) throw templateError(`Upload a ${mediaField.mediaType} for this template header.`);
        add({ type: prefix, parameters: [{ type: mediaField.mediaType, [mediaField.mediaType]: { id: item.id, ...(mediaField.mediaType === 'document' && item.name ? { filename: item.name } : {}) } }] });
        continue;
      }
      const location = matching.filter(field => field.kind === 'location');
      if (location.length) {
        const latitude = Number(values['header.location.latitude']), longitude = Number(values['header.location.longitude']);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw templateError('Enter a valid header location latitude and longitude.');
        add({ type: 'header', parameters: [{ type: 'location', location: { latitude, longitude, name: requiredText(values, location.find(field => field.locationPart === 'name')), address: requiredText(values, location.find(field => field.locationPart === 'address')) } }] });
        continue;
      }
      const parameters = matching.filter(field => field.kind === 'text').map(field => ({ type: 'text', text: requiredText(values, field), ...(field.parameterName ? { parameter_name: field.parameterName } : {}) }));
      if (parameters.length) add({ type: prefix, parameters });
      continue;
    }
    if (type !== 'BUTTONS') continue;
    (component.buttons || []).forEach((button, index) => {
      const matching = fields.filter(field => field.component === 'button' && field.index === index);
      if (!matching.length) return;
      const subType = matching[0].subType;
      let parameters;
      if (subType === 'flow') parameters = [{ type: 'action', action: { flow_token: requiredText(values, matching[0]) } }];
      else parameters = matching.map(field => {
        const value = requiredText(values, field);
        if (subType === 'quick_reply') return { type: 'payload', payload: value };
        if (subType === 'copy_code') return { type: 'coupon_code', coupon_code: value };
        return { type: 'text', text: value, ...(field.parameterName ? { parameter_name: field.parameterName } : {}) };
      });
      add({ type: 'button', sub_type: subType, index: String(index), parameters });
    });
  }
  const preview = (template.components || []).flatMap(component => {
    const type = String(component.type || '').toUpperCase();
    if (type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(String(component.format || '').toUpperCase())) return [`[${String(component.format).toLowerCase()} header]`];
    if (type === 'BUTTONS') return (component.buttons || []).map(button => button.text ? `Button: ${button.text}` : '').filter(Boolean);
    const prefix = type.toLowerCase(); const rendered = String(component.text || '').replace(variablePattern, (_, key) => values[`${prefix}.${key.trim()}`] || `{{${key}}}`);
    return rendered ? [rendered] : [];
  }).join('\n');
  return { payload: { name: template.name, language: { code: template.language }, components }, preview: preview || `[${template.name} template]` };
}
const ranks = { queued: 0, sending: 1, unknown: 1, sent: 2, delivered: 3, read: 4, failed: -1 };
const statusCanAdvance = (current, next) => next === 'failed' ? !['delivered', 'read', 'failed'].includes(current) : current === 'failed' && next === 'sent' ? false : (ranks[next] ?? -1) > (ranks[current] ?? -1);
module.exports = { phone, windowOpen, visible, accessible, canReply, canNote, signature, templateFields, templatePayload, statusCanAdvance };
