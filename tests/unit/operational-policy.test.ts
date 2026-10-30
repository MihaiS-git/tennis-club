import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeOperationalChange, coachRestrictionPolicy, financialConsequenceAccepted, operationalChangeInputSchema,
  operationalFinancialQuote } from "@/lib/bookings/operational-policy";

const admin = randomUUID(), coach = randomUUID(), otherCoach = randomUUID(), both = randomUUID();
const active = (...roles: string[]) => ({ status: "active" as const, roles });
const lesson = (assignedCoachUserId: string | null) => ({ kind: "coaching" as const, assignedCoachUserId });
const court = { kind: "court" as const, assignedCoachUserId: null };

describe("operational authorization", () => {
  it("lets an active Admin manage any court booking or lesson, independent of coach assignment", () => {
    for (const booking of [court, lesson(coach), lesson(null)])
      expect(authorizeOperationalChange("admin", admin, active("admin"), booking)).toEqual({ ok: true, capacity: "admin", actorUserId: admin });
  });

  it("lets a Coach manage only lessons currently assigned to them", () => {
    expect(authorizeOperationalChange("coach", coach, active("coach"), lesson(coach)).ok).toBe(true);
    expect(authorizeOperationalChange("coach", coach, active("coach"), lesson(coach.toUpperCase())).ok).toBe(true);
    for (const booking of [lesson(otherCoach), lesson(null), court])
      expect(authorizeOperationalChange("coach", coach, active("coach"), booking).ok).toBe(false);
  });

  it("denies revoked roles and suspended or missing accounts", () => {
    expect(authorizeOperationalChange("admin", admin, active("coach"), court).ok).toBe(false);
    expect(authorizeOperationalChange("coach", coach, active("admin"), lesson(coach)).ok).toBe(false);
    expect(authorizeOperationalChange("admin", admin, { status: "suspended", roles: ["admin"] }, court).ok).toBe(false);
    expect(authorizeOperationalChange("coach", coach, { status: "suspended", roles: ["coach"] }, lesson(coach)).ok).toBe(false);
    expect(authorizeOperationalChange("admin", admin, null, court).ok).toBe(false);
  });

  it("gives an Admin+Coach account only the permissions of the operation's capacity", () => {
    expect(authorizeOperationalChange("coach", both, active("admin", "coach"), lesson(otherCoach)).ok).toBe(false);
    expect(authorizeOperationalChange("coach", both, active("admin", "coach"), court).ok).toBe(false);
    expect(authorizeOperationalChange("admin", both, active("admin", "coach"), lesson(otherCoach)).ok).toBe(true);
  });

  it("lets an Admin override any coach's restrictions and a Coach only their own", () => {
    const asAdmin = authorizeOperationalChange("admin", both, active("admin", "coach"), lesson(otherCoach));
    const asCoach = authorizeOperationalChange("coach", coach, active("coach"), lesson(coach));
    const asBothCoach = authorizeOperationalChange("coach", both, active("admin", "coach"), lesson(both));
    if (!asAdmin.ok || !asCoach.ok || !asBothCoach.ok) throw new Error("expected authorization");
    expect(coachRestrictionPolicy(asAdmin, otherCoach, true)).toBe("override");
    expect(coachRestrictionPolicy(asCoach, coach, true)).toBe("override");
    // A Coach reassigning their lesson may not override the destination coach's restrictions.
    expect(coachRestrictionPolicy(asCoach, otherCoach, true)).toBeNull();
    expect(coachRestrictionPolicy(asBothCoach, otherCoach, true)).toBeNull();
    for (const authorization of [asAdmin, asCoach]) expect(coachRestrictionPolicy(authorization, otherCoach, false)).toBe("enforce");
  });
});

describe("operational change input", () => {
  const input = { id: randomUUID(), expectedRevisionId: randomUUID(), expectedUpdatedAt: "2099-01-01T10:00:00.000Z",
    locationId: randomUUID(), courtId: randomUUID(), date: "2099-01-02", startMinute: 600, overrideCoachRestrictions: false, save: true };

  it("accepts placement and coach only; program, duration and participants are never requested", () => {
    expect(operationalChangeInputSchema.safeParse(input).success).toBe(true);
    expect(operationalChangeInputSchema.safeParse({ ...input, coachUserId: randomUUID() }).success).toBe(true);
    for (const extra of [{ programId: randomUUID() }, { endMinute: 720 }, { participantCount: 2 }, { totalAmountMinor: 1 }])
      expect(operationalChangeInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    for (const startMinute of [615, -30, 1440]) expect(operationalChangeInputSchema.safeParse({ ...input, startMinute }).success).toBe(false);
  });
});

describe("staff financial consequence", () => {
  const quote = (current: number, destination: number, refundable: number, paymentMethod: "online" | "pay_at_club" = "online") =>
    operationalFinancialQuote({ currentAmountMinor: current, destinationAmountMinor: destination, currency: "RON", paymentMethod,
      refundableMinor: refundable });

  it("keeps an equal price without consequence", () => {
    expect(quote(10000, 10000, 10000)).toEqual({ consequence: "none", currency: "RON", currentAmountMinor: 10000,
      destinationAmountMinor: 10000, customerAmountMinor: 10000, refundMinor: 0, absorbedMinor: 0 });
  });

  it("never raises the customer's obligation: the club absorbs a dearer destination", () => {
    expect(quote(10000, 15000, 10000)).toMatchObject({ consequence: "club_absorbs", customerAmountMinor: 10000, absorbedMinor: 5000, refundMinor: 0 });
    // After an earlier reduction to 80, a 120 destination keeps 80; the waived 20 is never reinstated.
    expect(quote(8000, 12000, 8000)).toMatchObject({ consequence: "club_absorbs", customerAmountMinor: 8000, absorbedMinor: 4000 });
    expect(quote(5000, 7000, 0, "pay_at_club")).toMatchObject({ consequence: "club_absorbs", customerAmountMinor: 5000, absorbedMinor: 2000 });
  });

  it("refunds only collected funds above the reduced obligation", () => {
    expect(quote(15000, 10000, 15000)).toMatchObject({ consequence: "refund", customerAmountMinor: 10000, refundMinor: 5000 });
    // Funds already returned or reserved by earlier obligations are not refunded again.
    expect(quote(15000, 10000, 12000)).toMatchObject({ consequence: "refund", customerAmountMinor: 10000, refundMinor: 2000 });
    // Never more than the reduction, even if more was collected.
    expect(quote(15000, 10000, 20000)).toMatchObject({ refundMinor: 5000 });
    // Nothing collected above the new obligation: the obligation simply falls.
    expect(quote(15000, 10000, 9000)).toMatchObject({ consequence: "amount_reduced", customerAmountMinor: 10000, refundMinor: 0 });
  });

  it("reduces the amount due at the club instead of refunding uncollected money", () => {
    expect(quote(10000, 8000, 0, "pay_at_club")).toEqual({ consequence: "amount_reduced", currency: "RON", currentAmountMinor: 10000,
      destinationAmountMinor: 8000, customerAmountMinor: 8000, refundMinor: 0, absorbedMinor: 0 });
  });

  it("requires explicit acceptance of any consequence exactly as quoted", () => {
    const absorbed = quote(10000, 15000, 10000), equal = quote(10000, 10000, 10000);
    expect(financialConsequenceAccepted(equal, undefined)).toBe(true);
    expect(financialConsequenceAccepted(absorbed, undefined)).toBe(false);
    expect(financialConsequenceAccepted(absorbed, { ...absorbed })).toBe(true);
    // A stale acceptance (another price, or a consequence that no longer applies) is refused.
    expect(financialConsequenceAccepted(quote(10000, 16000, 10000), absorbed)).toBe(false);
    expect(financialConsequenceAccepted(equal, absorbed)).toBe(false);
  });

  it("accepts a financial acceptance only in the quote's own shape", () => {
    const base = { id: randomUUID(), expectedRevisionId: randomUUID(), expectedUpdatedAt: "2106-01-01T00:00:00.000Z", locationId: randomUUID(),
      courtId: randomUUID(), date: "2106-01-04", startMinute: 600, overrideCoachRestrictions: false, save: true };
    const accepted = quote(10000, 15000, 10000);
    expect(operationalChangeInputSchema.parse({ ...base, financialAcceptance: accepted }).financialAcceptance).toEqual(accepted);
    expect(operationalChangeInputSchema.safeParse({ ...base, financialAcceptance: { ...accepted, consequence: "surcharge" } }).success).toBe(false);
    expect(operationalChangeInputSchema.safeParse({ ...base, financialAcceptance: { ...accepted, absorbedMinor: -1 } }).success).toBe(false);
    expect(operationalChangeInputSchema.safeParse({ ...base, financialAcceptance: { ...accepted, total: 1 } }).success).toBe(false);
  });
});
