# Conversational core V2

V2 is a separate decision core behind the existing worker, not a new WhatsApp,
invoice, payment or assignment system. The old engines remain available for rollback.

## Execution modes

`AI_ENGINE_VERSION` overrides the editable `engineVersion` setting:

- `v1`: existing conversational engine, selected by `structuredSales` as before.
- `shadow`: existing engine handles customers; V2 processes isolated snapshots and
  logs comparisons. This is the default for the new code, not a database migration.
- `v2`: V2 decisions use the existing worker/outbox. DRAFT is supported; LIVE is
  additionally blocked unless `AI_V2_LIVE_APPROVED=1` is explicitly configured.

OFF still disables processing. No deployment or production setting change is
performed by this implementation. Do not enable the LIVE gate before replay and
controlled DRAFT acceptance. Roll back by setting the engine to `v1`; normal
configuration revisions still cancel stale queued output. Environment-only switches
also require restarting workers and reviewing pending drafts before resuming.

V2 model precedence: admin `v2Model`, then `OPENAI_V2_MODEL`, then the existing model
configuration / `OPENAI_MODEL`. Existing V1 replies keep their model. Shadow and
real-model tests incur API usage. Every text turn uses interpretation and semantic
selection. Composition and independent grounding add calls when needed, with at most
one composition repair. App usage reservation applies to every call. The model-call
deadline is 65 seconds overall, inside the existing 90-second worker lease.

## Pipeline and ownership

1. `context.js` builds a turn from all supplied inbound messages, successful outbound
   history, and the most recent successfully sent question. Queued, failed and unsent
   drafts cannot anchor a yes/no answer. Real status/delivery timestamps are read from
   the message record. Approved edited drafts lose question metadata if the text changed.
2. `contracts.js` / `model.js` interpret meaning via strict outputs, with exact evidence
   substrings and message IDs. The interpreter does not choose prices or call tools.
   Schema enums constrain values; no phrase recognizer vetoes the customer's wording.
3. `state.js` validates evidence, ranges, allowed values and contradictions. Confirmed
   commercial facts require explicit evidence and confidence >= .85. Other proposals
   remain tentative. Replacements require an explicit correction and preserve history.
   Legacy affirmative slots are not permission. A prior negative hold is preserved;
   ambiguous old many-to-many selections require clarification rather than charging
   for inferred combinations. Historical fields remain available as untrusted context.
4. `knowledge.js` selects eligible records against the UPDATED projected state. A compact
   semantic catalogue goes to the selector; full bodies go only to composition for
   selected IDs. No embeddings or extra database vendor is required. The adapter can
   later be replaced with hybrid retrieval. The current catalogue bound is 500 records.
5. `planner.js` chooses missing information, quotes and actions. Purchase items are
   platform/service pairs. A missing account is not consent to charge for setup.
   Shared multi-platform budgets require allocation clarification. Services/plans and
   `pricing.js` remain authoritative. Financial arithmetic never comes from OpenAI.
6. `ledger.js` accounts for every evidenced semantic need, including statements and
   mixed requests. `compose.js` is the single renderer. Pure backend templates can skip
   composition. Financial details use backend-issued fact IDs; STRICT applies to its
   own segment. Free prose and legacy KB wording require claim grounding and request
   coverage checks. A bounded repair must revalidate the entire ledger.
7. Existing worker guards validate ownership, input/version/configuration freshness.
   Existing invoice and handoff executors run only on active decisions. The outbound
   queue stores question metadata and its actual sending status establishes context.

## Corrected state and authority boundaries

- `consent.js`: ordered, evidenced decisions per purchase/item. Later refusal or
  deferral overrides assent, survives price-input changes, and still permits support
  answers. Fresh explicit purchase assent is required to resume payment progression.
- `state.js`: explicit platform/service items, scoped facts and quote dependencies.
  Changes invalidate affected item quotes and the aggregate; unrelated item facts and
  plans survive. Purchase-path switches save and restore budgets with their own path.
  The compatibility projection clears stale financial fields and exposes typed budgets.
- `budget.js` / `planner.js`: daily spend, total spend, inclusive caps, package choices
  and counteroffers are separate meanings. Inclusive caps search the existing calculator
  using integer-naira inputs; fees are never discounted or added above the cap. Ambiguous
  allocation is clarified. A configured package amount already includes its fee.
- `authority.js`: backend facts/actions > scoped business policy > eligible knowledge
  > preferred wording > composer flexibility. Builtin technical/policy defaults have
  explicit provenance; knowledge overrides are validated before rendering. Business
  policy wording can use `v2_negotiation`, `v2_deferred`, `v2_handoff`, `v2_cap` and
  `v2_mismatch` structured knowledge records. No production records are seeded here.
- `compose.js`: typed PRICE, PAYMENT_STATUS, DESTINATION, GUARANTEE, DISCOUNT and
  PERMISSION assertions cannot be authorized by ordinary KB prose. Backend fact
  references are integrity-bound to the issued plan. Harmless nonfinancial digits are
  allowed in grounded explanations. Invoice text is generated separately by the trusted
  existing invoice executor from actual payment fields; V1 keeps its original template.
- `delivery.js`: prepared questions/quotes/invoices are distinct from sent effects.
  Only successful sends/receipts advance the visible stage. Current-selection checks
  reject stale effects; a later failed status withdraws the corresponding sent stage.
  Verified paid state cannot be downgraded. History recovery also loads the last sent
  stage effect independently of the last question.
- `privacy.js`: credential-shaped spans are removed while benign credential discussions
  remain readable. This is redaction, not a semantic intent matcher. Inbound text is
  preserved in storage; turns over 24,000 characters explicitly route to staff instead
  of silently losing their tail. Test-history overflow is explicitly rejected.

Negative decisions and answered-question evidence are retained, not dropped after a
small fixed number of turns. Actual sent-question records preserve purpose, options,
expected fields, status and answer evidence. Queued/failed drafts never become anchors.

`ai.state.core` stores facts, superseded values, purchase items, saved purchase contexts,
topic, purchase path, readiness, question answers and quote provenance. Human ownership
stays in the existing authoritative `ai.active` / `assignedTo` fields. Payment truth
stays in verified Invoice records. Compatibility fields are projected for the existing
UI, invoices and follow-ups; V2 does not use `salesPaused` to choose answers.

## Knowledge roles

Admin entries can specify `contentRole`:

- `KNOWLEDGE`: approved factual source for natural composition.
- `RESPONSE`: approved customer wording, including STRICT responses.
- `GUIDANCE`: internal instructions, never a verbatim customer answer.

Legacy instructional entries have an explicit compatibility mapping in `knowledge.js`.
Legacy mixed answer/instruction records are not eligible for verbatim response parts.
Prices, permissions, verification and mandatory actions remain backend policy. Tone
comes from the tone configuration. Legacy workflow scripts do not run inside V2.
Review legacy records into these roles; no request-time seeding or bulk overwrite occurs.

## Shadow isolation

`shadow.js` owns `InboxAIShadowJob` and `InboxAIShadowMemory`. Snapshots are redacted,
deduplicated by conversation/input/configuration, globally leased and processed in
order. Shadow facts persist independently; question references use REAL sent messages,
never hypothetical shadow replies. Job/memory retention is seven days. Completed job
snapshots are removed. Comparison logs use `kind=shadow` in existing AI activity logs.

Shadow has no invoice, send, notification, assignment or conversation-update executor.
Deletion waits for active shadow processing and purges its jobs/memory with Inbox data.
Run the existing `npm run inbox:indexes` deployment procedure to create the new unique,
queue and TTL indexes along with existing Inbox indexes. Do not run it against production
as a casual test.

## Validation commands

- `npm run test:ai-v2`: core, architectural regression and ephemeral-Mongo isolation/API tests.
- `node --test inbox/ai/engine.test.js inbox/ai/structured.test.js`: old engine regressions.
- `node scripts/evaluateConversationV2.cjs --live-model`: billable synthetic evaluation,
  no DB connection, WhatsApp sending, invoice generation or assignment.
- Add `--model gpt-4.1` to compare a candidate without changing live settings.
- Add `--case 0` (zero-based) to narrow a failed scenario.

The Admin Test Agent exposes both engines; V2 uses the same context builder, state
contracts, retrieval, calculator, planner and renderer as the worker. Only effects are
simulated. It preserves nested/array state. Debug output shows evidence acceptance,
rejections, retrieval candidates/selections, authoritative plan, composition and errors.

## Release checklist

Replay anonymized real failures and successes, then review shadow comparisons. Include
service clarification, combined services, corrections, deferral, course detours, plan
selection, daily/total budgets, invoice reuse, human takeover and unsupported questions.
Inspect semantic errors, not only whether an output is valid JSON. Pass DRAFT with real
sent-question context before authorizing a limited LIVE rollout. Never auto-promote from
test success. Do not delete V1 until controlled production acceptance is complete.

Known data issue found in validation: the starter 15-day plan amount (285000) does not
match the existing calculator preset. V2 can show its configured total in a recommendation
but marks its breakdown unavailable; it refuses to fabricate that breakdown or invoice
from the mismatch. Resolve the authoritative commercial data before LIVE acceptance.

The initial 400-log audit is not a full replay benchmark. Synthetic evaluation does not
prove production readiness. Keep the LIVE gate closed while broadening acceptance.

## Validation after architectural corrections (2026-10-06)

The combined V2/V1 local run passed 122 tests (70 V2; 52 V1). Seven additional focused
Inbox tests passed for outbox delivery, takeover, invoice reuse, worker leases, receipt
ordering and draft approval. Model calls and external providers were replaced by test
doubles; database tests used temporary MongoDB. Frozen adversarial results were preserved.

No real-model success rate is claimed for this revision. The previous evaluation ended
with `credit_balance_exhausted`; no paid API calls were retried during these corrections.
The independent grounding verifier is still a model: semantic classification and
entailment are probabilistic. Typed checks deterministically enforce its output contract,
but they do not constitute a mathematical proof that arbitrary prose is safe. Redaction
likewise does not recognize every conceivable unlabeled secret. Broader real-model
adversarial replay and controlled DRAFT review remain required before release.

The supplied correction specification ends mid-sentence in Fix 13. This implementation
covers the supplied requirements; it cannot certify unseen continuation requirements.
No deployment, LIVE change, production migration or commercial price edit was performed.
