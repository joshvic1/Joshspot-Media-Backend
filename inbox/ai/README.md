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
