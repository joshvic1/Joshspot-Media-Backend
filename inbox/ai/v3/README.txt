JOSHSPOT V3 — LOCAL IMPLEMENTATION
2026-10-06

Status
------
Implemented alongside V1 and V2. No deployment, production-data migration,
engine activation, paid OpenAI evaluation or real payment request was performed.
V1 is the default. Existing saved configuration is not automatically changed.
V3 requires real-model validation before LIVE approval; passing mocked tests
does not establish language accuracy, commercial correctness or release safety.

The complete second continuation has now been reconciled with this implementation.
Thirty multi-turn golden scenarios are prepared as DATA ONLY and have NOT run.

Architecture
------------
Inbox webhook -> existing debounce/lease worker -> selected engine.
V3 -> actual delivered history in an OpenAI Conversation -> Responses tool loop
   -> selected business knowledge / existing calculator / guarded business tools
   -> one model-written response -> small deterministic financial checks
   -> existing draft / outgoing queue / human-assignment workflow.

There is no V3 intent regex classifier, phrase dictionary, sales-stage planner,
slot state machine, second normal-response composer or per-response LLM judge.
OpenAI interprets choices, references, corrections, deferral, course detours and
multiple questions using the actual conversation. Prompts instruct it to answer
questions before progressing and to ask only for genuinely missing information.
Those semantic behaviours must still be demonstrated with real-model tests.

Payment creation alone has an additional narrowly scoped OpenAI authorization
check. It reads current evidence, delivered history and the backend quote; it
does not write the customer response or control ordinary conversation. Backend
checks quote identity/expiry/revision/recalculation, latest message ID/evidence,
existing invoice, ownership and config revision independently. NEEDS_CONFIRMATION
is returned on ambiguity. An ALLOW from this check is not a formal proof that
natural-language intent was understood; adversarial testing remains required.

Files (relative to backend)
---------------------------
inbox/ai/runtime.js                 Saved engine selection and LIVE gates.
inbox/ai/v3/index.js                Bounded Responses orchestration.
inbox/ai/v3/openai.js               HTTP adapter, usage, narrow payment check.
inbox/ai/v3/context.js              Persistent Conversations and recovery.
inbox/ai/v3/instructions.js         Concise core behaviour, no hardcoded prices.
inbox/ai/v3/contracts.js            Strict tools plus server-side validation.
inbox/ai/v3/catalogue.js            Enabled catalogue + V3 knowledge projection.
inbox/ai/v3/tools.js                Trusted function dispatch and side-effect gate.
inbox/ai/v3/pricing.js              Existing-calculator adapter; no copied fees.
inbox/ai/v3/financial.js            Existing invoice adapter, trusted payment block.
inbox/ai/v3/validation.js           Literal amount/URL/payment/guarantee backstop.
inbox/ai/v3/worker.js               Draft/live integration, guards and logs.
inbox/ai/v3/testAgent.js            Actor-scoped, server-owned test sessions.
inbox/ai/v3/cost.js                 Optional standard-token cost estimates.
inbox/ai/routes.js                 Existing settings, test and draft routes.
inbox/models.js                    Separate ai.v3 Mixed document.
models/Invoice.js                  V3 quote fingerprint on generated invoices.
../frontend/components/admin/AIAgent.js  V1/V2/V3 selection, Save notice, Test UI.

The existing calculator vendor file, WhatsApp transport, billing provider,
assignment strategy, V2 core, existing knowledge editor and prior evaluations
were not replaced. Existing invoice generation gained a V3-specific guarded
path; V1/V2 authorization and formatting remain their existing paths.

Tool contract
-------------
get_services / get_service_details: enabled service prices, facts and course URL.
get_recommended_ads_plans: inclusive configured prices with calculator breakdown.
calculate_ads_quote: scoped platform/service items with explicit DAILY_AD_SPEND,
TOTAL_AD_SPEND, ALL_IN_BUDGET or PACKAGE basis. Unknown basis is rejected.
get_business_knowledge: model-selected IDs from a compact catalogue; no keyword
gate or vector database. Only requested details are supplied.
create_invoice: current quote + latest customer evidence, independently checked.
get_invoice_status / check_payment_status: server-resolved conversation invoice.
handoff_to_human: current context summary and a bounded reason code, handled by
the existing assignment/recovery machinery after final eligibility checks.

Setup fees come from service records. Management fees and creative configuration
come from the existing calculator. An all-in management cap is inverted through
that calculator, not a second fee formula. purchaseCap bounds the ENTIRE quote,
including setup and every platform's fees, and is fingerprinted and rechecked
before invoicing. Multiple inclusive items require a confirmed overall cap and
allocation; missing allocation needs clarification. A failed recalculation clears
the earlier quote so it cannot be invoiced by mistake. Quote amounts have the existing integer
invoice constraint. Course checkout stays on the existing course page.

Financial safety
----------------
One quote fingerprint binds the existing invoice automation key. Repeat tool
calls within a turn are cached; repeat financial execution across worker retries
reuses the same database invoice key. An uncertain provider operation is not
automatically retried into another payment account. Conflicting, paid or expired
invoices require review. Ownership is checked immediately before creation and
again before payment-account generation. A staff takeover during an already
in-flight external request cannot undo that request; the result must not be sent
after takeover and the existing invoice remains available for staff review.

The model includes the tool's exact paymentText block, with normal accompanying
answers before it. Corrupted financial blocks fall back to the existing trusted
template. That exceptional fallback can omit the accompanying prose; the log
records paymentFallback. Payment claims/receipts never mark a database row paid.

The final backstop detects literal unapproved currency amounts and URLs, obvious
unverified payment confirmations and straightforward guarantees. It is purposely
small, not a semantic security proof. Unusual wording, number words, bare domains,
mislabelled valid numbers and indirect guarantees need adversarial real-model
validation; do not treat this MVP as cleared for LIVE.

Context and state
-----------------
ai.v3 stores the OpenAI conversation ID, synchronization IDs/size, dirty marker,
advisory summary, current authoritative quote, invoice ID and operation ID.
V1/V2 ai.state is not used as conversational truth and is not erased by V3.
Actual received messages and sent/delivered/read outbound messages are imported.
Queued, failed and unsent drafts are excluded. Model work is removed from the
remote conversation at turn completion; actual sent wording is synchronized on
the next turn. This prevents an unsent draft becoming a customer-visible question.

The ID persists across successful turns. A missing ID, dirty interrupted context
or a large synchronization gap triggers bounded reconstruction, never import of
V1/V2 inferred state. Recovery imports at most 80 actual messages. Normal turns
add only unseen messages. A long conversation rotates after 70,000 stored
characters or 140 synchronized IDs using a bounded advisory summary plus recent
actual context. Summaries cannot authorize payment or set financial truth.

Native server compaction was researched but is not assumed compatible with every
configurable model/Conversation combination. The MVP uses explicit bounded
summary rotation. This adds an occasional model call, not an unlimited history
replay. Retired remote Conversations are not purged by this MVP; define retention
and deletion policy before a broader rollout. Test sessions expire locally after
one hour (maximum 40); a server restart requires resetting the test conversation.

Limits and cost
---------------
At most 6 Responses iterations and 16 function calls per turn, with a 70-second
transport deadline and 25-second per-request maximum. The existing worker lease
is 90 seconds. Recovery input is bounded; the knowledge index is limited to 500
records / 70,000 characters; requested full knowledge is capped at 45,000 chars.
Maximum output tokens default to 1,800 per call; existing reply character limits
also apply. Calls consume the existing configured usage budgets.

Usage includes input, cached input, output, total tokens and attempted model
calls (including payment authorization and summary calls). Estimates currently
cover gpt-4.1 and gpt-4.1-mini standard text pricing, verified on 2026-10-06.
Unknown models show null cost rather than zero. Estimates exclude taxes, special
service tiers, residency uplifts and future rate changes. No model cost was
incurred by the implementation tests.

Modes and switching
-------------------
Settings -> AI Engine -> V1, V2 or V3 -> Save. A short change notice explains that
records are preserved. V1 + V2 shadow comparison remains an advanced option.
A saved selector wins over the legacy AI_ENGINE_VERSION environment fallback.
Config revisions invalidate old responses, including in-flight V3 work.

TEST: select V3 in Test Agent; server-owned context persists between turns.
No real invoices, bank accounts, messages, customer updates or assignments.
Read-only enabled business records are used. Usage/log records are still written.

DRAFT: same core with actual eligible conversation context; invoice and handoff
actions are simulated. Staff can approve ordinary drafts. Simulated invoice
drafts cannot be sent as though an invoice exists: use the existing manual
Generate Invoice action. Explicitly approving a handoff draft uses the existing
human-assignment workflow. Draft approval is not automatic.

LIVE: implemented routing/tools/outbox guards, but requires BOTH manual LIVE
configuration and AI_V3_LIVE_APPROVED=1 on the backend. Neither was enabled.
After initial release authorization, selecting an engine does not require code
deployment. Existing V1/V2 automatic follow-up generation is suppressed while V3
is selected, preventing a second response authority. V3 currently checks payment
on customer turns; autonomous payment-event replies/reminders are not added.

Returning V3 -> V1 -> V3 retains engine memory and resynchronizes actual messages.
Human takeover always cancels pending AI eligibility. Media remains safe handoff;
the text MVP does not add audio transcription, vision or video processing.

Knowledge findings (saved snapshot, config revision 30; no fresh DB query)
------------------------------------------------------------------------
57 enabled knowledge records were inspected. V3 ignores legacy workflow/response
records and stateUpdates/requiredState/requiredQuestion/handoffAfterReply execution
fields. Approved explanatory text remains visible to the model.
Legacy STRICT template flags become preferred/GUIDED wording in V3's read-only
projection; saved records and V1/V2 behaviour are not changed. Exact financial
wording is controlled by trusted tools, not old qualification templates.

Four knowledge entries contain unresolved placeholders: setup_requirements,
custom_management_price, recommended_ads_plans, service_price. Final output
rejects unresolved placeholders; tools provide actual requirements/prices.
There are many overlapping STRICT explanations and qualification questions;
review whether these really need exact wording rather than natural explanations.
Old handoff flags can disagree with the explanatory wording. The new projection
ignores the flags but does not silently rewrite that business content.
No exact duplicate text was found within knowledge-only entries. The earlier
audit's duplicate pairs crossed knowledge/legacy-response types, which V3 does
not execute together. These are data-review findings, not permission to edit.

OWNER RESOLVED LOCALLY, 2026-10-07: 15-day plan
Correct configured total: NGN 265,000 (plan_15 local default/evaluation catalogue).
Existing calculator: NGN 200,000 ad spend + NGN 65,000 management = NGN 265,000.
Source: inbox/ai/vendor/adsPricingConfig.mjs recommendation preset and unchanged
duration/management functions. The gap is NGN 20,000.
Owner confirmed the calculator is correct. Local plan/tests now agree with it;
calculator code is unchanged. The live plan_15 data.amount still contains 285,000
and requires a separately authorized production update. Earlier reports/snapshots
remain historical evidence. Full original local audit:
evaluations/v3-implementation-20261006/knowledge-audit.json

Validation performed
--------------------
37 V3 deterministic/mock integration tests, including temporary MongoDB and a
stubbed payment provider. 122 existing V1/V2 regression tests. AI Admin ESLint.
The broader Inbox suite passed 84 of 85 tests. One unchanged test expects a
mention to grant CSS access to someone else's conversation, contradicting the
unchanged assigned-only policy. Neither that policy nor its test was changed.
No production database was connected for these tests. No real OpenAI call was
made. Real model tool-schema compatibility, conversational quality, long-running
semantic consistency and real provider latency remain unverified.

Persistent conversation IDs do not make history tokens free; the model still
processes retained context. Bounded summaries and cached-input billing control
that cost. Logs include a live deliveryRecord from the existing message outbox
when an outgoing message exists; QUEUED alone is never reported as sent.

Run: npm run test:ai-v3
Next release step: owner reviews this report, then explicitly approves the small
golden run (one configured model, one sample per conversation, no LLM judge).
Fix observed problems, then DRAFT, explicitly approved limited LIVE, and finally
full LIVE only after confidence is established. No automatic promotion.
Dataset: evaluations/v3-implementation-20261006/golden-conversations.cjs
Complete 28-item report: evaluations/v3-implementation-20261006/completion-report.txt

Official references consulted
------------------------------
https://developers.openai.com/api/docs/guides/conversation-state
https://developers.openai.com/api/docs/guides/function-calling
https://developers.openai.com/api/docs/guides/compaction
https://developers.openai.com/api/reference/typescript/resources/conversations/subresources/items
https://developers.openai.com/api/docs/models/gpt-4.1
https://developers.openai.com/api/docs/models/gpt-4.1-mini
