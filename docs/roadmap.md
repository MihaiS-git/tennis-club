# Roadmap

Status of the product scope. Implemented behavior is documented in the linked documents;
everything under *Planned* or *Deferred* has no routes, tables or UI today.

## Implemented

- Authentication with mandatory email confirmation, password recovery, optional `admin` and
  `coach` roles, account suspension ([security](security.md)).
- Player profiles with private avatars ([profiles](profiles.md)).
- Locations, courts, coverage periods, effective-dated opening hours and court pricing
  ([booking domain](booking-domain.md), [pricing](pricing.md)).
- Guest and authenticated court booking with checkout holds, Stripe one-time payments (manual
  capture), Pay at club, owner rescheduling with surcharges/partial refunds, owner and Admin
  cancellation with refunds ([payments](payments-memberships.md)).
- Coaching programs, coach profiles, coach availability and prices; online Private and
  Semi-private lessons ([coaching](coaching.md)).
- Staff direct reservations and Admin/Coach booking areas.
- Admin users, payments transactions/reconciliation, provider settings and club email settings.
- In-app notifications and Brevo transactional email ([notifications](notifications-delivery.md)).

## Partially implemented

- **NETOPIA:** configuration status and provider selection exist; there is no checkout or refund
  adapter, so selecting it disables online payment.
- **Group and Junior coaching:** configuration and public informational rates exist; sessions are
  arranged by staff and paid at the club, with no online booking.
- **Guest bookings:** guests can book and pay; guest self-management (reschedule/cancel) is not
  implemented.
- **Financial model:** booking revisions, capture receipts and refund executions are implemented;
  complete immutable refund/return observations and automatic reconciliation of capture-amount
  mismatches are not (mismatches require Admin review).

## Planned

- Memberships, subscriptions, discounts and entitlements (Stripe Subscriptions; application-owned
  entitlement rules; a ledger for any consumable credits).
- Coaching packages.
- TanStack Query, only when an interactive client-side server-state workflow needs it.
- Possible later expansion: recurring bookings, waiting lists, club leagues, tournaments, club
  events, advanced player statistics.

## Deferred indefinitely

Matches, partner matching, match results, Elo/rankings, rating history and match history. Do not
add `/matches` or `/rankings` routes, tables or navigation without an explicit scope change.

## Non-goals

Multi-tenancy, microservices or a separate backend, another ORM, event sourcing, AI partner
matching, complex dynamic pricing, a tournament engine and generic multi-sport abstractions.
