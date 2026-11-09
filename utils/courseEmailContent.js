const { botUrl } = require('../telegram/access');
module.exports = function courseEmailContent(invoice) {
const whatsappAccess = invoice.product === "whatsapp-course";
const accessUrl = botUrl(invoice);
const action = whatsappAccess ? 'Access your course on Telegram' : 'Access your courses on Telegram';
const accessText = accessUrl
  ? `Click the button below to access your course on Telegram:\n\n${accessUrl}`
  : 'Telegram access is being prepared. Please use the access button on the course page shortly.';
const actionButton = accessUrl ? `<p><a href="${accessUrl}" style="display:inline-block;padding:12px 18px;background:#229ED9;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">${action}</a></p>` : '';
return {
      subject: whatsappAccess ? "How to run WhatsApp Status ads — Joshspot Media" : "How to run Tiktok, Fb and Ig ads — Joshspot Media",
      text: whatsappAccess ? `Your payment is confirmed!\n\nThanks for buying the WhatsApp Status ads course.\n\n${accessText}\n\nKeep this email so you can find your way back anytime.\n\nJosh` : `Your payment is confirmed!

${accessText}

Keep this email so you can always find your way back.

The tutorial contains:
- How to register on TikTok Ads Manager, set things up and start running ads from scratch.
- How to create Facebook ad campaigns without getting confused by the buttons inside Ads Manager.
- How to run Instagram ads to your Instagram page, WhatsApp or website.
- How to create a simple online store where people can see your products and place orders.
- How to open and arrange your ads account properly before you start spending money.
- How to add your card and fund your ads account.
- How to choose the right audience for your ads.
- How to connect your ad to a landing page or store so people can buy or message you.
- How to choose videos and pictures for your ads.
- How to read your ad results, see what is working and know what to fix.
- How to retarget people who have watched, clicked or shown interest in what you sell.
- How to avoid common beginner mistakes that waste your ad budget.

See you inside the channels!
Josh`,
      html: whatsappAccess ? `<p>Your payment is confirmed!</p><p>Thanks for buying the WhatsApp Status ads course.</p>${actionButton}<p>Keep this email so you can find your way back anytime.</p><p>Josh</p>` : `<p>Your payment is confirmed!</p>${actionButton}<p>Keep this email so you can always find your way back.</p><ul><li>How to register on TikTok Ads Manager, set things up and start running ads from scratch.</li><li>How to create Facebook and Instagram ad campaigns.</li><li>How to choose the right audience, use content and understand ad results.</li><li>How to create a simple online store and retarget interested people.</li></ul><p>See you inside the channels!<br/>Josh</p>`,

};
};
