# Joshspot Inbox

The CRM entry point is `/crm-inbox`. It uses the existing admin/CRM JWT sessions and Staff records. This is an integrated inbox with a real database and provider service; missing credentials result in a disconnected state. No production mock success responses exist.

## Connect WhatsApp

Configure these **backend** environment variables in Railway (locally, `backend/.env`). Do not prefix secrets with `NEXT_PUBLIC_` or put them in frontend code.

| Variable | Obtain it from |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | A Meta Business system-user token with access to the WhatsApp account and the `whatsapp_business_messaging` and `whatsapp_business_management` permissions. Use a production token rather than the temporary API Setup token. |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta app → WhatsApp → API Setup → Phone number ID. This is an ID, not the displayed phone number. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp Business Account ID (WABA) in the same setup screen/business settings. |
| `WHATSAPP_APP_SECRET` | Meta app → App settings → Basic → App secret. Used to verify raw webhook signatures. |
| `WHATSAPP_VERIFY_TOKEN` | Generate a long random secret. Enter this exact value in Meta's webhook verification form as well. It is separate from the access token. |
| `WHATSAPP_GRAPH_VERSION` | The supported Graph API version chosen for your Meta app, in `vNN.0` format. No aging version is silently assumed. |
| `JWT_SECRET` | The existing CRM signing secret; required by this module. Keep the existing production value. |
| `MONGO_URI` | The existing application's MongoDB connection string. |

1. Deploy the backend and frontend changes. Keep the Express backend running continuously: its five-second worker drains persisted inbound and outbound jobs. A serverless process that shuts down between requests is not suitable for this worker.
2. Set Meta's callback URL to **`https://joshspot-media-backend-production.up.railway.app/api/inbox/webhook`**, or the equivalent HTTPS URL if the backend domain changes. Do not use the frontend proxy as Meta's webhook endpoint.
3. Verify with the configured verify token, subscribe to the **messages** webhook field, and subscribe the app to the WABA. The Cloud API number must be registered and available for messaging. A configured flag in the UI means the variables exist, not that Meta has verified the token or phone.
4. Create/approve templates in WhatsApp Manager. In Inbox → Templates, an administrator clicks **Refresh from Meta**. The inbox never treats arbitrary text as an approved template. Catalogues older than 24 hours must be refreshed before new template sends.
5. Have an opted-in test customer message the connected number. Confirm that the conversation arrives, claim it, reply, and verify delivered/read states. Check a supported template outside the 24-hour window. No live send has been performed by the automated tests.

The frontend's optional server-only `BACKEND_API_URL` includes the `/api` suffix. It defaults to the existing Railway API. For local testing set it to `http://localhost:5000/api` in `frontend/.env.local`, then restart Next.js. Existing CRM pages retain their existing API configuration.

Official references: [Meta Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [WABA webhook subscriptions](https://www.postman.com/meta/whatsapp-business-platform/folder/ozgs3jn/webhook-subscriptions), [Meta signature validation example](https://github.com/fbsamples/whatsapp-api-examples/tree/main/signature-validation-with-webhooks-payloads).

## Operation and permissions

The inbox has a dedicated full-workspace shell with an icon rail. Folders (All, Mine, Unassigned, Unread, Follow Up, Resolved) live in the list filter; Contacts, Templates, Team and connection settings stay in the same app. At widths of 1280px and above, customer details open inline; smaller screens use a modal drawer. Mobile uses list → conversation → back, with composer sizing tied to the visual viewport.

Follow-ups accept a future date/time, stored as a UTC `followUpAt` on the conversation with the existing revision and permission checks. The UI uses the operator's device timezone and marks overdue follow-up rows. Resolving or marking a conversation open clears its schedule. This is a lightweight scheduled flag, not an email or notification automation. No outbound messages are triggered by follow-ups.

Customer details use collapsible sections, with separately paginated media and notes/activity. Contact filters include source, customer status and labels; template filters include category, language and approval status. Reply and internal-note drafts are separate, and switching modes cannot carry an internal draft into a customer reply.

- Admins can view all conversations, assign/unassign any eligible staff member, reply, edit customers, resolve/reopen and sync templates.
- Existing `SS` and `CSS` staff see their own and unassigned conversations. They must claim an unassigned conversation before sending, adding notes or changing customer details. They cannot reassign someone else's conversation. `SES` has no inbox access because its existing CRM role excludes customer phone details.
- Staff roles are loaded from the database on each request and before an outbound send. Removing or changing a staff record takes effect without waiting for its JWT to expire.
- Assignment/status/label edits and customer edits carry revision numbers. Concurrent stale writes receive HTTP 409. Activity messages record actor, time and change. Admin identity remains the existing shared administrator identity, not a new staff system.
- Notes and audit messages have `direction: internal` and cannot enter the outbound queue. They are clearly marked in the chat.
- Admin-only invoice summaries and safe service-record fields are matched by normalized phone. Login credentials, invoice tokens and private CRM fields are never returned. Links open the existing service dashboard; record IDs are shown for identification. CRM collections themselves are unchanged.
- Contacts are deduplicated by E.164 digits (including Nigerian `080…` conversion). Custom labels live on conversations. Contact identity fields live in one contact record; service/customer records remain referenced through phone matching.

## Message reliability

- Signed webhooks are acknowledged **after** their raw-body hash and payload are persisted. Worker leases recover after process failure. Message provider IDs and normalized phone numbers have unique indexes.
- Inbound processing is repeatable: retries repair conversation metadata without creating duplicate messages. Completed payload jobs expire after seven days; permanent provider message IDs remain unique in message history. Dead jobs remain for inspection. Administrators can requeue dead jobs through the inbox warning action.
- Outbound messages are saved before delivery and atomically claimed by a worker. Browser retries use a stable client ID. A request timeout or worker crash becomes `unknown`, not an automatic resend that might duplicate a customer's message. Later status webhooks can reconcile it. Only definitively failed messages offer a retry button.
- Each send attempt has a distinct opaque callback identifier. An old attempt's delayed status must not overwrite a later attempt. Delivered/read states cannot regress. Queued messages recheck assignment, staff access and the service window immediately before provider submission.
- Message histories are paginated by ID. Conversation lists use date/ID cursors and 40-row pages. Unread state uses per-agent message IDs, so two messages received in the same second are distinguishable.
- Polling runs every five seconds in chat and seven seconds for lists/counts, pauses in hidden tabs, and preserves older list pages while scrolling. Recent message statuses refresh; loading earlier messages retrieves their current states.
- Search supports name/phone/email prefixes, labels and full-text message keywords; matching IDs are bounded to 500 candidates per search source. Narrow the query if a broad term has more matches. This avoids returning entire customer/message collections to the browser.

## Media and templates

- Outbound attachments: PNG, JPEG and PDF up to 5 MB. The server checks file signatures, uploads to Meta and returns a short-lived actor/conversation-bound ticket. Incoming image, document, audio, video and sticker IDs are retained; attachments are retrieved through authenticated backend routes.
- Image previews are loaded on demand. Other attachments download rather than executing inside the app. Provider media URLs must use an allowlisted HTTPS Meta host with no redirects; downloads are capped at 20 MB, use no-store and nosniff, and fail clearly when Meta's retention expires. SVG/HTML uploads are not accepted. This is not antivirus scanning; add a scanning service if the business later requires one.
- Supported outbound templates: approved text headers, text bodies and footers with numbered variables. Variable validation and preview happen before submission. Media/button/named-variable templates are displayed as unsupported rather than sent incorrectly. Meta remains authoritative and can reject a changed/revoked template.
- The service window is based only on inbound customer messages; sending a template does not open it. No pricing constants are embedded.

## Database and deployment

New Mongoose models: `InboxContact`, `InboxConversation`, `InboxMessage`, `InboxWebhookJob`, `InboxTemplate`, and short-lived `InboxRateBucket`. Existing models are not migrated or rewritten. Mongoose creates their indexes when initialized. If production disables automatic indexes, run `npm run inbox:indexes` with the normal backend environment before opening the inbox; it creates missing indexes without dropping existing ones. Use an appropriate MongoDB backup/retention policy for customer conversations.

`routes.js` owns validation/access checks, `service.js` owns persistence and workers, `provider.js` is the only Meta API boundary, and `policy.js` contains testable rules. For future channels, add a provider implementing the same send/template/media contract and dispatch by `Conversation.channel`; do not add provider SDK calls to React.

`service.events` exposes `message.received` and `message.sent` extension hooks. They are best-effort process-local hooks, not a durable automation bus. Reliable AI/automation should consume persisted message IDs and maintain its own cursor/idempotency keys. No AI vendor is required and no automation sends are enabled.

Monitor worker error logs, dead webhook jobs, failed/unknown outbound states, and Meta token validity. Logs contain operation names and record IDs, not tokens or message bodies. Mutations have a Mongo-backed per-actor minute limit shared across backend instances. Reverse-proxy request/connection limits should be applied as part of normal hosting operations.

## Verification

From `backend`: `npm run test:inbox`. Tests use `mongodb-memory-server`, an isolated temporary MongoDB and stubbed provider. They do not load `.env`, use production customers or contact Meta. The first run may download MongoDB. Node 22+ is required by the test dependency and native FormData/Blob support.

From `frontend`: `npx eslint components/inbox pages/crm-inbox.js "pages/api/inbox/[...path].js" components/crm/CrmLayout.js components/admin/AdminLayout.js`, then `npm run build`.

Manual acceptance: open a staff and admin session separately; receive a test message; claim, reply, note, label and resolve it; confirm the other agent cannot access the claimed conversation; test at desktop and 390px mobile widths (list → conversation → back, then customer drawer). Browser automation was unavailable in this workspace during implementation, so this visual check and live Meta delivery remain deployment acceptance steps.
# October 2026: bounded loading and staff mentions

## Delivery worker incident safeguards

Local Node servers do not start the Inbox worker by default, even if their `.env` points to the production database. Railway (`RAILWAY_ENVIRONMENT_ID`) and production Node environments do; `INBOX_WORKER_ENABLED=false` always disables it. Explicit `INBOX_WORKER_ENABLED=true` is for a deliberately isolated development worker. Do not run an old checkout's worker against the production database.

Webhooks persist routing phone IDs before acknowledgment. Workers only claim matching jobs (or legacy unrouted jobs). A legacy phone mismatch is marked `blocked`, retains its payload and appears in administrator failed-job counts; it can no longer silently finish as `done`. Completed payloads are retained for seven days under the existing TTL for diagnostics/recovery. Outgoing messages record their intended phone ID, so a mismatched worker cannot claim them. This does not restore payloads already discarded by older code.

Administrator-only `/diagnostics` exposes queue state and worker/result metadata without customer text or credentials. `/connection-check` validates the running server's token with a read-only Meta request. `scripts/inspectInboxDelivery.cjs` is a read-only local diagnostic using `.env`, with no tokens or customer message bodies in output. Do not confuse its local-token result with Railway's token.

- Conversation pages now contain 20 records, using the existing `(lastMessageAt, _id)` cursor. The browser appends the next page on scroll and deduplicates rows.
- Default message history covers the last 24 hours by server arrival time (`createdAt`). Each response is limited to 50 records. Opaque `page` cursors continue the same period before advancing to earlier periods; empty historical periods are skipped. Older history remains in the database. `target` loads bounded context ending at a particular message for notification deep links.
- `changes` cursors retrieve only changed messages, including receipts. The UI merges updates into loaded history. Large reconnect backlogs are drained in bounded batches.
- Internal notes accept up to 10 validated `mentions` staff IDs. Notifications have a unique `(recipient, message)` index. A durable `mentionsPending` flag lets the existing worker repair interrupted notification creation. Notes never enter the WhatsApp outbox.
- Mentioning a staff member grants that staff member persistent read access to the conversation via `collaborators`. It does **not** grant reply, assignment, contact-edit or invoice permissions. The composer explains this access. Current SS/CSS roles are checked on every authenticated API request. Notifications are private to the recipient.
- `/events-ticket` issues a single-use 30-second ticket; the same-origin proxy returns the direct backend event URL. `/events` sends content-free invalidations, heartbeats and closes after four minutes for fresh authentication. At most three streams per actor stay open. Never log ticket query strings. CORS must allow the exact frontend origin.
- One MongoDB change stream per backend process coalesces updates. Atlas supports this. If unavailable, same-process mutations still notify clients and periodic reconciliation provides a fallback. Frontend refreshes serialize, coalesce bursts, pause in hidden tabs and back off failures. Reconciliation is every 120 seconds with an open stream, or 30 seconds without one (longer after errors).
- The existing single-flight worker retains its bounded 25-webhook / 15-outbound batches per tick; pending mentions are processed in batches of 25. No Redis service or extra paid notification provider is needed.

Deployment: deploy the backend **before** the frontend, retain the existing `BACKEND_API_URL`, and run `npm run inbox:indexes` if automatic MongoDB index creation is disabled. No historical-message migration is necessary. Use **one backend replica** for this release: stream tickets are process-local. Before adding replicas, replace the ticket store with shared short-lived storage or another authenticated streaming handshake. Do not put SSE through the Vercel function proxy.

Verification: integration tests include permissions, 20-row cursors, 24-hour windows, large-day caps, empty-period skipping, delta updates, duplicate mentions, notification recovery and single-use stream authentication. Frontend `scripts/check-inbox-updates.cjs` covers scroll pagination, tagging and recipient deep links with isolated browser fixtures; `scripts/check-inbox-layout.cjs` covers desktop, tablet and mobile layouts. Neither script sends real WhatsApp messages.
