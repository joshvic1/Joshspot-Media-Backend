# Inbox earnings and device notifications

Local implementation; no production activation or payroll transfer is performed by deployment.

## Activate
Admin → Staff earnings → Manage rules and monthly statements → Activate tracking.
Defaults: Africa/Lagos, Monday–Saturday 08:00–20:00, 15-minute grace, ₦1,000 per completed five-minute excess, ₦100,000 monthly cap. Working days Monday–Saturday and rules are editable; Sunday is always excluded, including older unfinalized rules. Finalized statements remain locked. Existing month rules remain frozen; changes apply to future monthly statements.

No retrospective deductions: only inbound messages recorded after activation are evaluated. Tracking cannot silently be paused after activation; use documented exclusions or adjustments when waiving charges.

## Calculation
Each uninterrupted unanswered customer-message sequence counts as one waiting period, starting at its latest inbound message. Superseded messages remain in the audit but do not contribute to the average. Assignment starts a new staff responsibility interval; earlier unassigned time is excluded. Reassignment closes the old interval as transferred and includes its working time in the former owner’s daily average and deductions. The new owner starts a fresh interval at assignment. Transferred intervals are not counted as answered or still pending. A successful staff outbound message closes outstanding inbound waits at its submit time, excluding provider queue delay. Failed/queued messages and notes do not count. AI/admin-covered waits are excluded, not credited as staff replies.

Only configured working-hour overlap is counted. Overnight waits resume at 08:00. Pending waits remain in live estimates at their current working age. Daily average = summed measured waits / counted responsibility intervals (answered, pending or transferred). Daily deduction = floor(max(0, averageMinutes − 15) / 5) × 1000. Example: 20/21 minutes → ₦1,000; 25 minutes → ₦2,000. Days are attributed to the inbound/assignment start date in Lagos. Daily amounts sum into monthly deductions, including reasoned admin adjustments, clamped between zero and the monthly cap.

Consecutive customer messages restart the current owner’s waiting period from the newest message. A staff reply ends the period; the next inbound starts a new period. This metric measures response speed, not answer quality. It does not determine whether a response actually resolved a question.

Pending/unreconciled records prevent finalization. Admin may exclude a wait with a staff-visible reason (e.g. outage) or apply a signed monthly adjustment. Finalization is permitted only for completed months and locks a snapshot; it never moves money. Staff see their own figures only, no salary. Admin selects staff and reviews detailed records.

## Implementation
- inbox/earnings/math.js: working-hour overlap, ownership replay, daily calculation.
- inbox/earnings/models.js: configuration, unique per-message response samples and monthly statements.
- inbox/earnings/worker.js: leased, bounded background reconciliation (10 conversations / 15 seconds); indexed dirty queue. Actual messages are replayed without their text. 20,000-message per-conversation safety limit blocks reconciliation rather than silently truncating accounting.
- inbox/models.js: assignment audit written alongside assignment changes; dirty flag.
- inbox/service.js: worker invocation and successful-delivery invalidation.
- inbox/earnings/routes.js: staff-scoped reports, admin rules, exclusions, adjustments and finalization. Reports allow a year maximum and reject over 20,000 samples; UI shows latest 100 audit records and supports narrowing dates.
- frontend/components/inbox/Earnings.js, styles/Earnings.module.css: shared staff/admin interface; visible-page refresh every 30 seconds.
- frontend/pages/admin-7812er/earnings.js: admin entry point.
- NotificationSettings.js: device/account preference defaults, collapsed controls and gesture-triggered permission request. Explicit opt-outs preserved. Native browser permission cannot be granted automatically. iOS requires a compatible Home Screen web app; denied browser permission requires device settings.

## Validation
Eight pure/integration checks with disposable Mongo and no real providers; mocked mobile browser check for permissions/defaults, collapsed controls, opt-out persistence and staff/admin UI separation; Next production build.

No customer content, API keys or real salaries are included in tests. Production needs both frontend/backend deployment, then explicit tracking activation. Historical figures before activation are intentionally absent. Browser/device notifications still depend on browser support, granted permission and configured push keys.

## Staff availability
The Inbox list header offers a staff-only Online/Offline switch. Status is explicitly chosen, not inferred from browser connectivity. Each Lagos day starts Online. An open break stops accruing at shift end. Sundays do not count. Daily breaks accumulate across devices; the server timestamps transitions and uses revision checks to reject stale device updates. One hour is free, then each completed extra five minutes adds 1,000 naira. This is separate from response waiting, combined under the monthly cap and finalization snapshot. No payroll transfers occur. Recorded offline intervals pause the same staff member’s response clocks (including pending and transferred waits); assignment eligibility stays unchanged. Late counts and response audits use the same net working time. Breaks beyond the report end date are included when needed for a response spanning that date; their offline charges remain attributed to the actual break date. Deduction details are available under the selected-period total. Daily breakdown exposes offline minutes and offline deductions. Tracking must first be activated by admin. Maximum 100 break starts per day prevents unbounded documents; reads are indexed by staff/day.

## Admin response controls
Admin → Staff earnings → choose staff → Response timer controls. A reason is required. Reset uses the selected date range: completed waits before reset are excluded; a wait still unanswered at reset restarts from the reset timestamp. Subsequent elapsed time counts, including after delayed reconciliation. New customer waits continue normally. Messages and offline deductions are preserved. Finalized months cannot be reset. Pause records a server-timed open interval, persists across days/devices/restarts, and ends only when admin resumes. Response time before pause remains; offline and admin-pause overlaps are merged to avoid double subtraction. Staff can view pause status and timer-change history but cannot invoke controls.

Timing version 2 is reconciled in bounded worker batches for older conversations. Finalized snapshots remain unchanged; finalization waits for reconciliation.

## Resolution timing (version 4)

New resolutions are recorded atomically with status in earningsResolutions (actor and timestamp). Assignment stays unchanged; the inline activity names the resolving staff member. A new customer message reopens the conversation.

Resolution completes the pending waiting sample at the resolution time, without exemption. This is counted as a completed handling period in the existing answered aggregate, with resolvedAt/resolvedBy metadata. A successful human reply without intervening customer input extends that same sample to the staff submission time, without duplication. Ownership transfers during the interval are split if a later reply extends it. New customer input after resolution preserves the completed period and starts a separate one.

Notes, activities, failed sends, AI messages, invoice follow-ups, course reminders and course-link automation do not extend resolved samples. Working hours, Sunday exclusions, offline and admin pauses still apply. Late resolutions appear in the late list, linked to the customer message.

Historical resolutions without structured events are not guessed from activity text. Finalized month snapshots remain locked. This local implementation does not deploy or edit production data.
