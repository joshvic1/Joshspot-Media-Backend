# Joshspot Inbox AI Agent

This module extends the existing Inbox webhook, conversation, assignment, notification and WhatsApp outbox. It does not replace them. Initialization is explicit and starts in **DRAFT**; missing configuration disables processing.

## Setup and rollout

1. Deploy the backend and frontend changes together. These changes do not deploy themselves.
2. Add server-only variables in Railway (never use NEXT_PUBLIC variables):

   ```dotenv
   OPENAI_API_KEY=replace_with_your_key
   OPENAI_MODEL=replace_with_your_Responses_API_structured_output_model
   ```

   Existing MongoDB, WhatsApp, PAYSTACK_SECRET and HTTPS CLIENT_URL settings are reused. An OpenAI model must support the Responses API and JSON-schema structured outputs. No model or API key is assumed.
3. Run `npm run inbox:indexes` from the backend against the intended database. This creates indexes, including unique automation invoice keys; it does not drop existing indexes. Do this before enabling workers for this feature.
4. Open `/admin-7812er/ai-agent` as an administrator. Select **Initialize in DRAFT**. Existing records are not overwritten by initialization.
5. Review services, prices, plans, knowledge, responses, workflows, escalation and payment settings. Invoice automation is disabled initially.
6. Use **Test Agent** with greetings, explicit advertising requests, contextual answers, payment claims, unsupported questions and media. This uses the configured model but never sends WhatsApp messages or generates payment accounts.
7. Review real suggestions in **DRAFT**. Staff can edit/send/dismiss suggestions and take over. Existing assigned conversations remain human-owned. Returning to AI applies to future inbound messages.
8. Only after validation, explicitly save **LIVE** with automatic replies enabled. **OFF** stops AI processing. Changing rollout mode clears queued generation work and stale drafts; queued automatic messages also check current mode/configuration before delivery.

Local development workers stay disabled by default. Do not enable them against a shared production database. The local frontend may point to Railway; new endpoints require a backend deployment before that frontend can use them.

## Architecture and guarantees

- Incoming messages are persisted by the existing durable webhook pipeline before AI work. A pending marker, debounce interval and per-conversation lease combine rapid messages without doing model work in the webhook request.
- The model classifies intent and extracts bounded context. Approved database records determine prices, service rules, workflow actions and invoice amounts. It cannot execute arbitrary tools or database actions.
- Structured state persists platform, service, budget, duration, plan, current step and invoice context. Recent history and retrieved knowledge are bounded. Daily/global and per-conversation call limits cap requests.
- Existing outbox delivery provides queued messages, provider status updates and real-time updates. Unique message keys prevent duplicate generation from producing duplicate sends. New input, human takeover or configuration changes invalidate stale automatic replies.
- Media, payment verification claims, sensitive content, unknown requests, low confidence and provider failures route to staff. Assignments support least-loaded, round-robin and fallback staff using existing CSS/SS roles. Notification links open the conversation.
- Human typing pauses AI. Staff can take over, return future messages, approve/edit a draft or dismiss it. An already accepted external provider request cannot be recalled.
- Invoice actions reuse `Invoice` and `generateInvoiceTransfer` from the existing invoice controller. An atomic claim and unique automation key prevent concurrent duplicate account creation. An uncertain Paystack result requires human review, never blind retry. The model never verifies payment or writes a paid status.
- Expired WhatsApp service windows require human use of existing approved templates; this module does not invent a template or bypass the window.
- Staff-response promotion creates a disabled knowledge/tone/response entry for administrator review. There is no silent self-training.
- OpenAI requests use `store: false`. Obvious credential-bearing text is excluded and email/phone-like identifiers are redacted from model context and decision logs. Redaction is not a guarantee that every possible secret can be detected. Original Inbox messages remain governed by existing message storage.

## Data and files

New collections: `InboxAIConfig`, `InboxAIRecord`, `InboxAILog`, `InboxAIUsage`. Conversation AI state, message automation guards, handoff notification kind and invoice automation metadata extend existing schemas. Usage counters expire after three days; audit logs persist.

Backend entry points: `routes.js` (staff/admin APIs), `config.js` and `defaults.js` (editable settings/seeds), `provider.js` (OpenAI adapter), `engine.js` (deterministic decisions), `worker.js` (leases/debounce/handoff/outbox), `invoices.js` (existing payment integration), `privacy.js` (redaction).

Frontend entry points: `components/admin/AIAgent.js`, `pages/admin-7812er/ai-agent.js`, `components/inbox/AIControls.js`, and their existing Inbox/Admin integration points.

Seeded services: TikTok setup NGN20,000; Meta setup NGN30,000; management plans 7 days NGN60,000, 10 days NGN135,000, 15 days NGN285,000, 30 days NGN415,000. All are editable database records.

## Verification and operational limits

`npm run test:inbox` runs isolated MongoDB tests with mocked external providers. Coverage includes duplicate webhooks, draft approval, live queue delivery, concurrent worker leases, takeover during generation, media/sensitive/error handoff, deterministic pricing and invoice reuse/uncertain generation. It does not send customer messages or charge Paystack.

`frontend/scripts/check-ai-admin.cjs` checks Admin editing, simulation, rollout settings and responsive layout using browser fixtures. Real OpenAI output quality, production permissions, verified payment callbacks and real WhatsApp delivery require credentialed staging validation before LIVE rollout.

The first version supports setup and management service types, safe condition-based workflows and staff roles already present in this CRM. It does not infer staff online availability, process media with AI, or introduce a second payment system.

API contract reference: https://developers.openai.com/api/docs/guides/structured-outputs

## Approved support content and mandatory onboarding handoff

`businessPack.js` contains 34 approved knowledge entries, five intent handoff rules, the approved behavioural instructions and invoice message. `node inbox/ai/installBusinessPack.js` previews the target database; add `--apply` to install once. The install preserves model, rollout mode, invoice enablement, service/plan prices and unrelated entries. Later edits are preserved on reruns. The admin-only `POST /api/inbox/ai/business-pack` performs the same installation.

Onboarding requirements are a reply-and-handoff action, including requirements emitted by a configured workflow. Knowledge entries can explicitly request CSS handoff after their answer; the Onboarding category also requires it. Payment, support and exception entries that promise staff review have that action configured, not merely text suggesting someone will help.

Assignment is recorded before the response enters the WhatsApp outbox. DRAFT assigns/notifies CSS and stores the response for approval; LIVE queues the one handoff response. Human ownership then blocks further automatic replies. Missing/deleted fallback agents fall back to the configured team. If no CSS account exists, AI pauses, an assignment error appears in the Inbox, and a durable retry runs every 30 seconds. Staff must exist for assignment to succeed. Interrupted notification/outbox work is recovered using idempotent keys; explicit manual takeover/assignment cancels recovery.

### Unlimited usage
Daily calls, per-conversation calls and consecutive AI turns accept `0` for unlimited. Existing configurations migrate once to zero on first configuration access after deployment; later administrator changes are preserved. Usage continues to be counted. OpenAI billing and provider rate limits still apply. Human takeover and business handoff rules remain active.

### Knowledge-first handoff policy
Onboarding responses and legacy record/workflow handoff flags no longer force transfer. The model is instructed to select approved knowledge before declaring a request unsupported. Low-confidence requests receive one clarification. Explicit human requests, media and payment claims still transfer; technical errors, sensitive data and unavailable authorized actions remain staff-review cases. Payment confirmation requires a paid invoice linked to this exact conversation; receiving a receipt alone is acknowledged without asserting payment success. No historical chats are automatically reassigned to AI by this policy change.

### Primary AI knowledge document
Admin page `/admin-7812er/ai-knowledge` edits one document (up to 200,000 characters) through admin-only GET/PUT `/api/inbox/ai/master-knowledge`. Saves use the shared config revision to prevent lost updates; standard settings saves preserve the document. Existing installations show a starter guide until saved. The complete document is included in model instructions; this is request-time guidance, not model training. Structured knowledge remains supplementary and authoritative invoice pricing/payment checks remain enforced. Structured model answers include a supporting source quote (or a clarification); waiting/staff-follow-up promises enter the real assignment path in both Test Agent and production. Larger documents increase input tokens.


## Structured sales redesign (opt-in, October 2026)

The sections above describe the retained legacy engine. With `structuredSales=true`,
the legacy master document is **not included in model requests**. Its data remains
available under Settings → Legacy knowledge reference for manual migration.

### Existing systems reused

| Responsibility | Implementation |
| --- | --- |
| Knowledge, services, plans and audit | Existing InboxAIRecord / InboxAIConfig / InboxAILog models |
| Customer messages, staff ownership and delivery receipts | Existing Inbox Conversation, Message, webhook jobs and outbox |
| Language understanding | Existing OpenAI Responses adapter, with a separate validated structured schema |
| Financial calculation | Unchanged `frontend/config/adsPricingConfig.mjs`, vendored into the independently deployed backend; parity regression test |
| Invoice / payment account | Existing Invoice and `invoiceController.generateInvoiceTransfer` |
| Payment truth | Existing verified Invoice status; no model or customer claim can mark it paid |
| Handoff and notifications | Existing worker assignment, notification and recovery paths |
| Scheduled invoice reminders | New bounded InboxAIFollowup jobs using the existing outbox |

### Runtime changes

`structuredEngine.js` interprets language, retains sales state, chooses a safe next
objective and renders editable knowledge responses. The backend owns prices,
calculator results, invoice actions and assignment. Bare agreement cannot change
the budget or skip the separate offer of payment details. Explicit requests for
account/payment details skip that offer. Service changes detach stale invoice
context without deleting financial records. Valid existing invoice amounts stay
fixed even when current service prices change.

Knowledge records support STRICT/GUIDED/KNOWLEDGE, matching examples, meaning,
required/excluded state, priority, facts, response, next question, payment guidance
and mandatory handoff. Financial/consent/ownership state cannot be written through
knowledge rules. Security and commercial prerequisites remain backend checks.
Retrieval bounds database candidates and supplies relevant facts to semantic
interpretation; it does not inject the giant legacy document or the full knowledge
collection. Edited structured response/fact text is mirrored into existing indexed
fields to retain search compatibility without rebuilding the Mongo text index.

The four primary admin sections are Knowledge Base, Services, Test Agent and Logs.
Plans are nested under Services. Settings contains global behavior, rollout,
payments, handoff and legacy reference. Test Agent keeps multi-turn history/state,
simulates invoice state without creating an invoice, and can simulate verified
payment. Structured DRAFT handoffs have no assignment or notification side effects.
Admin state corrections and assignment retry are available in Inbox AI controls.

### Migration and release procedure

No production migration or new LIVE activation was run during implementation.
No new environment variable is required: existing OpenAI, Meta, MongoDB, Paystack
and CLIENT_URL configuration is reused. Never put provider secrets in the frontend.

1. Deploy the backend with the existing configuration. `structuredSales` defaults
   to false; current OFF/DRAFT/LIVE and ownership are preserved.
2. Run `npm run inbox:indexes` in the backend environment. This creates additive
   indexes, including reminder idempotency and due-job lookup. No index is dropped.
3. Deploy the frontend. Open AI Agent → Settings → Migration and legacy reference.
4. Preview, then prepare structured knowledge. `GET/POST /api/inbox/ai/structured-migration`
   reports new keys and legacy records needing review. Inserts are idempotent;
   existing services, prices, plans, rules, document, ownership and mode are untouched.
   The original records are preserved in place. Export configuration before manual
   edits; the export deliberately redacts possible credentials/private numbers.
5. Review entries labeled Legacy and any old service requirement that merely says
   “Hold on”. Such a promise still requires a real handoff; do not treat it as an
   approved factual answer. Review existing custom-plan and package-inclusion
   responses, which may contain older human-review instructions.
6. Enable structured sales in DRAFT. Test the current configuration in Test Agent
   and a controlled DRAFT conversation. The API prevents first activation in LIVE
   and requires successful TEST and DRAFT decision records at the current revision
   before a later LIVE transition. Review actual replies, not just the mode gate.
7. Use a designated test WhatsApp recipient to validate incoming persistence,
   staff-approved outgoing delivery and delivery receipts. Do not create unwanted
   customer invoices. Only then enable LIVE deliberately.
8. Review early logs and provider/assignment/outbox errors. No claim about reduced
   production handoff rate or conversion is made from synthetic tests.

Rollback: turn AI OFF/auto-reply off, then set structuredSales=false. Original
legacy records and master document are retained. Restoring an edited record can
use its audit history; do not delete financial records or Inbox collections.
The additive schema/seed migration does not require destructive downtime.

### Reminder and payment details

Reminders are disabled by default, maximum two per invoice (default 4 and 24 hours).
The `payment_followup` knowledge entry supplies their text. Each job checks current
ownership/version/input, invoice identity/status/expiry, opt-out/decline state,
successful invoice-message send, global mode and the WhatsApp service window,
again immediately before sending. Catch-up jobs are separated by at least an hour.
Closed-window reminders are cancelled unless an approved template path is added;
they do not send arbitrary generated text as a fake template. Existing invoices
expire after eight hours, so a 24-hour reminder for such an invoice is cancelled.

Paid records are reconciled in bounded pages by the existing worker every 30 seconds
without a new model call or payment-provider polling. Verified payment cancels
reminders, stops sales and enters fulfilment handoff when AI still owns the chat.
No eligible representative leaves a visible pending assignment and a durable retry.
Staff takeover and resolved/deleted chats invalidate stale automation.

### Validation and external acceptance

Automated regression coverage includes the old Inbox suite, structured sales,
calculator parity, consent, pricing, invoice simulation, actual handoff vs DRAFT,
missing staff recovery, reminders, verified payment, state corrections, migration
and access control. Browser fixtures cover admin CRUD/Test Agent/settings and Inbox
AI controls on desktop/mobile. `scripts/testStructuredSales.cjs --live-provider`
(and `--setup`) exercises synthetic conversations with the actual configured model,
without MongoDB, WhatsApp, invoice or payment writes. These opt-in evaluations incur
normal OpenAI usage. The deterministic tests do not call external providers.

Production deployment, real WhatsApp validation, DRAFT observation and live business
content review remain release gates. Local tests are not proof of an 80% production
resolution rate. No live-customer invoice or message was generated by this work.
