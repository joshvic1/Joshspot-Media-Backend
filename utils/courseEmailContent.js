const { courses, whatsappCourseUrl } = require("./courseAccess");
module.exports = function courseEmailContent(invoice) {
const whatsappAccess = invoice.product === "whatsapp-course";
return {
      subject: whatsappAccess ? "How to run WhatsApp Status ads — Joshspot Media" : "How to run Tiktok, Fb and Ig ads — Joshspot Media",
      text: whatsappAccess ? `Your payment is confirmed!\n\nThanks for buying the WhatsApp Status ads course. Join the Telegram training channel below to start learning:\n\n${whatsappCourseUrl}\n\nKeep this email so you can find your way back anytime.\n\nJosh` : `Your payment is confirmed!

Here are your course links. Join both Telegram channels and start learning. Keep this email so you can always find your way back.

${courses.map((course) => `${course.title}: ${course.url}`).join("\n\n")}

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

};
};
