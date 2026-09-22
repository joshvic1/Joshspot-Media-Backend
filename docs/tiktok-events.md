# TikTok course purchases

Set `TIKTOK_ACCESS_TOKEN` and `TIKTOK_PIXEL_ID` in the backend hosting environment. The local token is stored only in the ignored `backend/.env`; deployment does not copy it automatically. Never put the token in frontend variables or source control.

The Paystack webhook and successful payment verification queue new confirmed ads-course purchases. A worker runs every minute and retries failed deliveries after five minutes. The existing browser Pixel remains active. Both use `Purchase` and `course-` plus SHA-256 of the invoice token as the event ID, so TikTok can deduplicate them. WhatsApp-course purchases use a separate flow and are excluded.

Email and international-format phone numbers are SHA-256 hashed for matching. No access link, raw contact information, or token is included in the event body. Click identifiers and browser matching cookies are not currently collected by this server integration, which limits attribution matching.

For verification, set `TIKTOK_TEST_EVENT_CODE` to the code shown in TikTok Events Manager and complete a new checkout. Check receipt there, then remove the test code before production traffic. A successful API response is stored as `tiktokPurchaseSentAt`; failures retain the queue and a generic error without logging credentials. This change has been tested with mocked HTTP/database calls; live token validity and TikTok receipt remain unverified.

References: [TikTok payload helper](https://business-api.tiktok.com/payload_helper/) and [event deduplication](https://ads.tiktok.com/help/article/event-deduplication?lang=en).
