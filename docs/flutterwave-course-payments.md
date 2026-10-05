# Flutterwave course checkout

New ads-course and WhatsApp-course payments use Flutterwave dynamic NGN virtual accounts. No provider selector is shown. Existing invoices without a provider remain Paystack invoices; other invoice creation remains Paystack.

## Configuration before deployment

Set these on the backend (Railway) and in local backend .env when testing locally:

```
FLUTTERWAVE_SECRET_KEY=<server-side secret key>
FLUTTERWAVE_WEBHOOK_SECRET=<your randomly generated webhook secret hash>
FLUTTERWAVE_BANK_CODE=090567
```

Use matching test credentials for sandbox testing and live credentials for production. Never put the secret key in frontend environment variables. Your Flutterwave account must be enabled for NGN virtual accounts.

In Flutterwave webhook settings, set the same secret hash and enable retries. Production callback:

`https://joshspot-media-backend-production.up.railway.app/api/payment/flutterwave/webhook`

Deploy both backend and frontend. Keep the Paystack webhook and credentials for existing transactions and other invoice flows. This change does not migrate old accounts or transactions.

## Verification

The server creates a single-use account with a unique invoice reference and displays the returned bank, beneficiary, transfer amount and expiry. Transfer amount may include Flutterwave fees; the underlying course price is kept unchanged for access checks.

The webhook authenticates the v3 verif-hash header and independently verifies the transaction through Flutterwave. Customer polling also verifies payments. A successful transaction must match the invoice reference, NGN currency and exact course price; mismatches do not unlock access. Duplicate callbacks cannot downgrade a paid invoice, and existing email/event delivery queues retain their idempotency.

An ambiguous account-creation timeout is not automatically retried for the same invoice, to avoid generating duplicate accounts. Such an invoice has paymentError ACCOUNT_GENERATION_REQUIRES_REVIEW; check its reference with Flutterwave before recovering it. No live merchant credentials were available during implementation, so a sandbox end-to-end payment and actual beneficiary/fee validation are required before release.

## Tests

`node scripts/testFlutterwaveCourse.js` uses disposable MongoDB and mocked provider requests, never production data. Covers course routing, verification, webhook authentication, account reuse, concurrent generation, timeout safety and legacy Paystack verification.

Official references:
- https://developer.flutterwave.com/docs/ngn-virtual-accounts
- https://developer.flutterwave.com/docs/webhooks
- https://developer.flutterwave.com/reference/verify-transaction-with-tx_ref
