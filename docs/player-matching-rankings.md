# Player Matching and Rankings

## Partner matching

Members can create requests to find a tennis partner.

Example:

```text
Looking for partner

Location: Central Club
Tuesday: 18:00–20:00
Level: 3.5–4.5
Game: Singles
```

Initial matching can consider:

- location;
- availability;
- player level/rating;
- game type;
- optional player preferences.

Keep the initial matching deterministic and simple.

Conceptual workflow:

```text
Create request
→ find compatible players
→ player accepts
→ choose common time
→ select court
→ book/pay
→ play
→ record result
→ update rating
```

AI-based partner matching is not required initially.

## Player profiles

Keep public tennis information conceptually separate from private account information.

Potential public tennis information:

- display name;
- rating;
- ranking;
- match statistics;
- rating history;
- optional tennis preferences.

Private information:

- contact information;
- billing-related data;
- account information;
- private preferences.

See `security.md` for access-control implications.

## Elo-style ranking

The initial ranking system uses Elo-style ratings.

The calculation belongs in TypeScript and should be deterministic.

A ranked match persistence operation must update atomically:

```text
match result
+
player A rating
+
player B rating
+
player A rating history
+
player B rating history
```

Never leave a partially applied rating update.

Use a transaction/RPC only for the atomic persistence step; keep the rating algorithm itself in TypeScript.

Unit-test the calculation independently of database persistence.
