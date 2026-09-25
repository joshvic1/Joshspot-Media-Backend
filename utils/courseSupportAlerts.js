const Invoice = require("../models/Invoice");
const { Resend } = require("resend");
const { refreshInvoiceStatus } = require("../controllers/invoiceController");
const { isCourse } = require("./courseAccess");
const RECIPIENT = "ptricia1310@gmail.com";
const escape = value => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));

function alertContent(invoice) {
  const name = invoice.customerName?.trim() || "there";
  const course = invoice.product === "whatsapp-course" ? "WhatsApp Status ads" : "TikTok, Facebook & Instagram ads";
  const rawPhone = invoice.customerPhone || (invoice.note || "").split("WhatsApp:")[1]?.trim() || "";
  let phone = rawPhone.replace(/\D/g, "");
  if (/^0\d{10}$/.test(phone)) phone = `234${phone.slice(1)}`;
  const validPhone = /^[1-9]\d{6,14}$/.test(phone);
  const message = `Hello ${name},\nI'm Trisha from the JoshspotMedia Team.\nWe noticed you tried paying for our ${course} course but couldn't complete the checkout. Is there any issue you encountered, or is there any question you have in mind?\n\nLet me know.`;
  const whatsapp = validPhone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : "";
  const call = validPhone ? `tel:+${phone}` : "";
  const time = new Date(invoice.createdAt).toLocaleString("en-GB", {timeZone:"Africa/Lagos",dateStyle:"full",timeStyle:"short"});
  const fields = [["Name",invoice.customerName || "Not provided"],["Email",invoice.customerEmail || "Not provided"],["Phone",rawPhone || "Not provided"],["Course",`${course} course`],["Checkout time",`${time} (Lagos)`]];
  const intro = "This course checkout has remained pending for more than 15 minutes. Payment was checked before this alert. Check its current status before reaching out, as payment may arrive later.";
  return {
    subject:`Pending checkout: ${course} course`,
    text:`${intro}\n\n${fields.map(([key,value])=>`${key}: ${value}`).join("\n")}\n\n${validPhone ? `Call: ${call}\nWhatsApp: ${whatsapp}` : "Call and WhatsApp are unavailable because no valid phone number was recorded."}\n\nSuggested message:\n${message}`,
    html:`<div style="font-family:Arial,sans-serif;color:#173e2b;max-width:600px;margin:auto;padding:24px"><h2>Course checkout needs follow-up</h2><p style="line-height:1.6">${intro}</p><table style="width:100%;border-collapse:collapse">${fields.map(([key,value])=>`<tr><th align="left" style="padding:10px;border-bottom:1px solid #ddd">${key}</th><td style="padding:10px;border-bottom:1px solid #ddd">${escape(value)}</td></tr>`).join("")}</table>${validPhone ? `<p style="margin:24px 0"><a href="${escape(call)}" style="display:inline-block;background:#234b36;color:#fff;padding:14px 20px;border-radius:8px;text-decoration:none;margin:0 8px 8px 0">Call customer</a><a href="${escape(whatsapp)}" style="display:inline-block;background:#17653a;color:#fff;padding:14px 20px;border-radius:8px;text-decoration:none">WhatsApp customer</a></p>` : "<p>No valid phone number was recorded.</p>"}<h3>Suggested message</h3><p style="white-space:pre-line;line-height:1.6">${escape(message)}</p></div>`,
  };
}

async function sendSupportAlert(id) {
  if (!process.env.RESEND_API_KEY) return "disabled";
  const now = new Date();
  const invoice = await Invoice.findOneAndUpdate({
    _id:id,status:"pending",deletedAt:null,supportAlertSentAt:null,
    supportAlertDueAt:{$lte:now},createdAt:{$lte:new Date(Date.now()-15*60*1000)},
    $and:[
      {$or:[{supportAlertClaimedAt:null},{supportAlertClaimedAt:{$lt:new Date(Date.now()-120000)}}]},
      {$or:[{supportAlertRetryAt:null},{supportAlertRetryAt:{$lte:now}}]},
    ],
  },{$set:{supportAlertClaimedAt:now}},{new:true});
  if (!invoice) return "skipped";
  const release = () => Invoice.updateOne({_id:id,supportAlertClaimedAt:now},{$unset:{supportAlertClaimedAt:1}});
  try {
    if (!isCourse(invoice)) { await release(); return "skipped"; }
    await refreshInvoiceStatus(invoice,true);
    // A webhook may have confirmed payment while verification was in progress.
    const current = await Invoice.findOne({_id:id,status:"pending",deletedAt:null});
    if (!current || current.supportAlertSentAt) { await release(); return "skipped"; }
    const {data,error} = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from:process.env.RESEND_FROM_EMAIL || "Joshspot Media <booking@joshspotmedia.com>",
      to:RECIPIENT,...alertContent(current),
    },{idempotencyKey:`course-support/${id}`});
    if (error) throw Error("Delivery failed");
    await Invoice.updateOne({_id:id,supportAlertClaimedAt:now},{
      $set:{supportAlertSentAt:new Date(),supportAlertEmailId:data?.id || ""},
      $unset:{supportAlertClaimedAt:1,supportAlertRetryAt:1},
    });
    return "sent";
  } catch {
    await Invoice.updateOne({_id:id,supportAlertClaimedAt:now},{
      $set:{supportAlertRetryAt:new Date(Date.now()+300000)},$unset:{supportAlertClaimedAt:1},
    });
    return "retry";
  }
}

let running = false;
async function checkSupportAlerts() {
  if (running || !process.env.RESEND_API_KEY) return;
  running = true;
  try {
    const rows = await Invoice.find({status:"pending",deletedAt:null,supportAlertSentAt:null,
      supportAlertDueAt:{$lte:new Date()},
      $or:[{supportAlertRetryAt:null},{supportAlertRetryAt:{$lte:new Date()}}],
    }).sort({supportAlertDueAt:1}).limit(20);
    for (const row of rows) await sendSupportAlert(row._id);
  } finally { running = false; }
}
module.exports = {alertContent,sendSupportAlert,checkSupportAlerts};
