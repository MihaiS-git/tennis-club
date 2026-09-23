# Payments and Memberships

## Separation of booking and payment state

Booking state and payment state are independent.

Expected payment states may include:

```text
unpaid
processing
paid
failed
partially_refunded
refunded
```

Do not assume:

```text
one booking = one financial transaction
```

A booking may have multiple financial operations:

```text
Booking
├── original payment
├── rescheduling surcharge
└── partial refund
```

## Stripe responsibilities

Stripe owns payment processing and subscription billing state.

The browser must not determine authoritative:

- price;
- discount;
- refund amount;
- payment status;
- membership entitlement;
- remaining credits.

The server independently calculates or retrieves authoritative values.

Use Stripe idempotency mechanisms for retryable operations.

## Webhooks

Stripe webhooks are authoritative for asynchronous Stripe state changes.

Potential event categories include:

- payment succeeded;
- payment failed;
- refund created/updated;
- subscription created/updated/cancelled;
- invoice paid;
- invoice payment failed.

Webhook processing must:

1. verify the Stripe signature;
2. process only supported event types;
3. be idempotent;
4. persist processed event IDs where appropriate;
5. safely handle duplicate delivery.

Conceptual flow:

```text
Stripe webhook
→ verify signature
→ inspect event ID
→ already processed?
    yes → acknowledge
    no  → process
→ persist state
→ store event ID
```

Never assume Stripe delivers an event exactly once.

## Refunds

Refund logic is an application decision derived from booking/payment state and cancellation policy.

Protect against:

- duplicate refunds;
- refunds greater than paid amount;
- refunds for unpaid transactions;
- unauthorized refund operations.

Use transactional persistence where multiple local state changes must remain atomic.

## Memberships

Potential plan categories:

- Standard;
- Premium;
- Coaching;
- Court Credits.

Possible benefits:

- booking discounts;
- included court time;
- coaching credits;
- advance booking access;
- priority booking;
- other configurable entitlements.

Stripe handles subscription billing.

Application code determines the actual entitlement rules.

Example:

```text
Stripe:
subscription active

Application:
Premium Membership
├── court discount
├── coaching credits
└── booking-ahead limit
```

Do not treat `Stripe subscription = active` as complete application authorization.

## Membership credits

If consumable credits are introduced, prefer a ledger/transaction model rather than relying only on one mutable balance field.

Credit consumption may require an atomic database operation together with booking confirmation or another protected workflow.
