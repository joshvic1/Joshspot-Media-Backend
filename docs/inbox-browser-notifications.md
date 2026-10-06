# Inbox browser notifications

Settings is available in the bottom menu and desktop navigation. Browser permission is requested only after pressing Enable. All categories default off, including after permission is granted. Preferences belong to the signed-in account and browser endpoint. Existing in-app Alerts are unaffected.

Categories: assigned conversations (manual/AI handoff), incoming customer messages visible to the user, staff mentions, and due follow-ups. Staff permissions are rechecked at delivery. Follow-ups notify the assigned person, or the administrator for unassigned chats. Rescheduled/resolved follow-ups are suppressed. Notifications show no contact names, numbers or message bodies. Clicks open the chat through the normal authenticated route.

## Deployment

Run `node scripts/configureInboxPush.cjs` once. This writes a stable VAPID pair to the ignored backend .env without printing it. Set INBOX_PUSH_PUBLIC_KEY, INBOX_PUSH_PRIVATE_KEY and INBOX_PUSH_SUBJECT on Railway. Keep the private key server-side. Deploy both projects, including the service worker and web manifest. Keep the existing Inbox worker enabled. Use HTTPS in production (localhost is supported for development).

An iPhone/iPad requires a compatible iOS version and launching the website from Add to Home Screen. Users must grant OS/browser permission; settings cannot override a denial. Delivery depends on network, browser/OS background support and device notification settings. The worker checks about every 15 seconds while active; this is not a guaranteed instant alarm. Disabled push configuration is shown explicitly in Settings.

Events are deduplicated and expire after seven days. Each device processes events in batches with a database lease and retry cursor. Push payloads expire after five minutes; expired browser endpoints are removed. New preferences do not replay older events. Changing notification switches resets the event cursor to now. Disabling unsubscribes the device; logging out from the Inbox also unsubscribes. Background notifications remain generic if another CRM page logs out without the Inbox unsubscribe helper.

Validation: `node --test --test-name-pattern="push preferences" inbox/integration.test.js` uses disposable MongoDB and a mocked push transport. No real notification is sent by that test. A real-device delivery check is still needed after deployment and opt-in.
