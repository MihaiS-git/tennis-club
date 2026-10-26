# Roadmap

## V1 — Club operations

### Foundation

- authentication;
- application user/profile foundation;
- RBAC;
- denied browser table grants and Storage RLS;
- locations;
- courts;
- coaches;
- availability.

### Booking

- court booking;
- court + coach booking;
- concurrency protection;
- booking holds;
- booking management.

### Payments

- Stripe one-time payments;
- Stripe webhooks;
- cancellations;
- refunds;
- partial refunds;
- rescheduling;
- price differences.

### Memberships

- plans;
- subscriptions;
- discounts;
- basic entitlements;
- credits where required.

### Administration

- operational dashboard;
- location management;
- court management;
- coach management;
- member management;
- booking management;
- payment/refund visibility.

## V2 — Tennis-specific features

- expanded player-profile features (basic `/profile` and avatars are implemented);

Deferred indefinitely (not planned):

- partner matching;
- match recording;
- Elo rating;
- rankings;
- rating history;
- match history.

## Possible later expansion

- tournaments;
- club leagues;
- recurring bookings;
- waiting lists;
- group coaching;
- notifications;
- advanced membership credits;
- guest players;
- advanced player statistics;
- club events.

## Implementation order

Recommended sequence:

```text
1. Supabase project and database foundation
2. Authentication, application users, roles and access control (denied browser table grants, Storage RLS)
3. Locations and courts
4. Court availability
5. Booking domain model
6. Database overlap protection
7. Basic booking UI
8. Booking holds
9. Stripe one-time payments
10. Coaches and coach availability
11. Court + coach booking
12. Cancellation/refund rules
13. Rescheduling
14. Membership plans and subscriptions
15. Admin operational dashboard
16. Partner matching (deferred indefinitely)
17. Match recording (deferred indefinitely)
18. Elo ranking (deferred indefinitely)
```

The intent is to prove the difficult security/concurrency/payment constraints before secondary tennis features.

## Non-goals

Do not introduce prematurely:

- multi-tenancy;
- microservices;
- a separate backend service;
- an ORM;
- event sourcing;
- AI-based partner matching;
- complex dynamic pricing;
- tournament infrastructure;
- generic multi-sport abstractions.

## Product assumptions

- one tennis club owns the platform;
- the club may operate multiple physical locations;
- courts belong to one location;
- coaches may work across multiple locations;
- members have one club-wide identity;
- memberships are club-wide unless explicitly restricted;
- rankings, if ever introduced, would be club-wide (currently deferred indefinitely);
- court and coach availability are location-specific;
- Stripe is the payment provider;
- Supabase Auth is the authentication provider;
- PostgreSQL is the primary application database;
- TypeORM is the application persistence and migration mechanism; `supabase-js` handles Auth and private Storage only;
- Supabase access is server-first;
- no browser Supabase client is used by default;
- TypeORM is the approved ORM; do not introduce another;
- no separate backend framework is required;
- Next.js is the complete primary application authorization boundary; application table grants deny direct browser access and Storage RLS protects private objects;
- domain algorithms remain in TypeScript;
- TypeORM transactions persist application changes; PostgreSQL constraints and triggers enforce integrity.
