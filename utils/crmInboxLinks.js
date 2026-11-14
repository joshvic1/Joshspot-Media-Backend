const { Contact, Conversation } = require('../inbox/models');
const policy = require('../inbox/policy');
const { canInbox } = require('../inbox/staffPermissions');

const canOpenInbox = (staff) => Boolean(staff?.admin || canInbox(staff));

// CRM records are intentionally linked by their stored WhatsApp number rather
// than by a client-supplied name. Names can be duplicated or changed, while a
// number identifies the Inbox contact safely.
async function linksForClients(clients, staff) {
  const links = new Map();
  if (!canOpenInbox(staff) || !clients.length) return links;

  const records = [];
  const phones = new Set();
  for (const client of clients) {
    try {
      const normalizedPhone = policy.phone(client.clientNumber);
      records.push({ id: String(client._id), phone: normalizedPhone });
      phones.add(normalizedPhone);
    } catch {
      // Legacy/manual records without a valid phone number simply cannot have
      // a trustworthy Inbox link.
    }
  }
  if (!records.length) return links;

  const contacts = await Contact.find({
    phone: { $in: [...phones] },
    deleting: { $ne: true },
  }).select('_id phone').lean();
  const contactsByPhone = new Map(contacts.map((contact) => [contact.phone, String(contact._id)]));
  const contactIds = contacts.map((contact) => contact._id);
  if (!contactIds.length) return links;

  const actor = staff.admin
    ? { admin: true }
    : { id: String(staff.staffId), admin: false };
  const conversations = await Conversation.find({
    $and: [
      policy.accessible(actor),
      { contact: { $in: contactIds }, channel: 'whatsapp', deleting: { $ne: true } },
    ],
  }).select('_id contact').lean();
  const conversationsByContact = new Map(conversations.map((conversation) => [String(conversation.contact), String(conversation._id)]));

  for (const record of records) {
    const contactId = contactsByPhone.get(record.phone);
    const conversationId = contactId && conversationsByContact.get(contactId);
    if (conversationId) links.set(record.id, conversationId);
  }
  return links;
}

module.exports = { canOpenInbox, linksForClients };
