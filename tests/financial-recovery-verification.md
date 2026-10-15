Verification performed on 2026-10-15 against the guarded `tennis-club-tests` project only (`127.0.0.1:55322/postgres`). Stripe SDK responses and Brevo HTTP responses were simulated. No development database operations, production code changes, builds, full suites, staging or commits were performed. The existing pending `DurableBookingNotifications1791462257928` migration was applied with the guarded test initializer.

The 17 added focused regression cases produced **16 PASS, 1 FAIL**. ESLint passed on all four changed/added TypeScript test files. The one failing regression is intentionally retained.

| Scenario | Result | Concrete evidence |
| --- | --- | --- |
| Partial refund: successful refunds never repeated | PASS | Split RON 75 cancellation: RON 25 refund dispatched once across repeated recovery cycles, including when the RON 50 remainder fails. |
| Partial refund: outstanding refunds recover | PASS | Temporary transport loss and affirmative `insufficient_funds` failure recovered automatically. A failed execution remained immutable; retry used a distinct execution/key after backoff. Final refunded amount RON 75, net paid zero. |
| Partial refund: booking changes wait | PASS | Booking revision and active reservation remained identical while only RON 25 had returned; cancellation applied only after all obligations succeeded. A nonretryable RON 50 failure preserved the booking and obligation. |
| Partial refund: discrepancies remain visible | PASS | Real financial-history projections retained captured 7500, refunded 2500, uncompleted obligations 5000 minor units; permanent failure remained a failed refund row. |
| Stripe after 24+ hours: recover existing refunds | PASS | A simulated accepted response was lost; after 25 hours, exact obligation/execution metadata recovered the provider refund. One create call and one execution across repeated runs. |
| Stripe after 24+ hours: prevent unsafe duplicates | PASS | Empty provider evidence after 25 hours left the original execution uncertain; repeated recovery never issued a second create. |
| Stripe after 24+ hours: explicitly record unresolved outcomes | PASS | Execution persisted `unresolved_after_idempotency_window`, no terminal success, lease released, financial obligation retained. |
| Stripe after 24+ hours: surface unresolved case to Admin | FAIL | After an interrupted dispatch and 25-hour outage, the first recovery check recorded the unresolved error, but the Admin attention projection returned no matching refund. See defect below. |
| Notifications: transaction durability and crash/restart | PASS | Enqueue rolled back with its transaction; duplicate committed event keys yielded one row. A child process exited with code 86 at the simulated HTTP submission boundary; another process could not claim its live lease, then recovered after controlled lease expiry using the same provider idempotency key. |
| Notifications: temporary Brevo failures | PASS | Simulated HTTP 503 persisted `delivery_unconfirmed`, attempts=1 and backoff. Immediate fresh-process retry submitted nothing; after moving the due time, a fresh process delivered successfully with attempts=2. |
| Notifications: concurrent delivery workers | PASS | Two separate Node processes delivered three pending rows exactly once each; attempts=1 per row. Another worker cycle submitted none again. |
| Duplicate webhooks | PASS | Concurrent identical events plus a distinct replay event produced exactly one capture receipt, one confirmation revision and one durable notification. |
| Concurrent recovery workers and repeated cycles | PASS | Concurrent real recovery runs dispatched one refund and shared one execution; a further cycle did not dispatch again. |
| Interrupted operations | PASS | A simulated booking-application failure after refund commit left the booking active and refund succeeded; recovery subsequently applied cancellation without another refund. Expired scheduler lease takeover succeeded; stale release could not clear the successor lease. |
| Autonomous execution | PASS | The scheduler timer recovered a real pending financial obligation with database I/O and simulated Stripe. Separately, a fresh Node process invoked the actual instrumentation registration and its real 15-second boot timer delivered committed pending mail, without any customer/Admin request. These were nonempty recovery runs. |
| External resolution of permanent provider refusals | NOT VERIFIED | The obligation and booking remain preserved and the discrepancy is visible. No real provider/account intervention was exercised. |
| Exactly-once email after ambiguous submission beyond provider retention | NOT VERIFIED | The worker provides durable at-least-once submission and reuses its key. Simulated provider responses cannot establish real Brevo deduplication guarantees. |

Defect: `tests/integration/db/refund-executions.integration.test.ts`, test beginning at line 552, reproduces the missing Admin attention entry. It persists a dispatch 25 hours in the past, models process interruption, and runs recovery with an empty provider refund list. Recovery correctly avoids creation and records `unresolved_after_idempotency_window`. However, changing the obligation from `pending` to `pending_retry` updates `payment_refunds.updated_at` to the current time (`payments.repository.ts:183`). Both the SQL attention filter (`payments.repository.ts:253`) and TypeScript stalled classifier (`payments/domain.ts`, `refundRecoveryStalled`) depend on that status timestamp rather than dispatch age or explicit unresolved evidence. Consequently, the genuinely unresolved case is excluded from attention for another 24 hours. Production code was left unchanged.

Existing coverage also needs maintenance. After schema initialization, the existing refund-execution file had 45 passing tests and three failing expectations: known-ID retrieval with an empty discovery-list mock; retaining an ID from mismatched provider evidence; and expecting a fresh dispatch after a 24-hour interruption despite missing evidence. The existing Stripe-refund and booking-notification unit files had 38 failures combined, including old exact-result shapes, empty discovery fixtures and transaction mocks without an active query runner. The scheduler unit file passed both tests. These existing failures were not rewritten or counted as additional verified production defects. Initial failures caused by the missing notification migration were superseded by post-initialization checks.

One intermediate notification-process run also failed three submission-count assertions. Diagnostic assertions were added; two subsequent complete runs passed all five process tests. The intermediate inconsistency was not explained and is a remaining test-reliability limitation, rather than a confirmed production defect. An earlier standalone scheduler attempt required a test-only directory-resolution hook for Node; production resolution was not changed.

Reproduce only the added regression cases (the attention defect makes the command exit nonzero):

```bash
npm run test:integration -- \
  tests/integration/db/refund-executions.integration.test.ts \
  tests/integration/db/booking-mutations.integration.test.ts \
  tests/integration/durable-recovery-verification.integration.test.ts \
  -t 'verification:|outbox rolls|temporary Brevo|crash after submission|two independent worker|real instrumentation'
```

The financial tests use controlled time advancement or persisted historical dispatch evidence instead of waiting 25 real hours. Crash tests use actual child-process death/restart and controlled lease expiry instead of waiting five or ten minutes. These tests exercise application recovery and database fencing; they do not validate live Stripe/Brevo availability or an entire Next.js server deployment.
