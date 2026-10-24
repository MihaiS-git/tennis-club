import { adjustmentHoldFragments } from "@/lib/bookings/domain";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { buildBookingRevision, capturePricingEvidence, pricingEvidenceSchema, sameRevisionContract, type RevisionTerms } from "@/lib/bookings/revision";
import type { PricingRule } from "@/lib/pricing/validation";
const id=randomUUID(), bookingId=randomUUID();
const terms: RevisionTerms={locationId:id,courtId:id,locationName:"Original club",courtName:"Original court",timezone:"Europe/Bucharest",
  bookingDate:"2099-10-15",startMinute:600,endMinute:660,customerName:"Guest",customerEmail:"guest@example.test",customerPhone:"123",
  totalAmountMinor:5001,currency:"RON",paymentMethod:"online",cancellationNoticeMinutes:1440,
  pricingEvidence:{version:1,rounding:"half-hour-sum-round",courtState:"outdoor",slots:[600,630].map(minute=>({minute,ruleId:id,ruleSetId:id,hourlyMinor:5001,startsOn:null,endsOn:null}))}};
const operation={id,bookingId,kind:"created" as const,bookingState:"pending_payment" as const,operationKey:"created",intentHash:"created",
  actorUserId:null,actorScope:"guest" as const,recordedAt:new Date(),adjustmentId:null,cancellationCause:null};
test("online creation is a pending snapshot and confirmation appends without rewriting it",()=>{
  const original=buildBookingRevision(terms,operation,null);
  const confirmed=buildBookingRevision(original,{...operation,id:randomUUID(),kind:"confirmed",bookingState:"confirmed",operationKey:"confirmation",actorScope:"provider"},original);
  expect(original).toMatchObject({revisionNumber:1,previousRevisionId:null,bookingState:"pending_payment"});
  expect(confirmed).toMatchObject({revisionNumber:2,previousRevisionId:id,bookingState:"confirmed",customerEmail:"guest@example.test",totalAmountMinor:5001});
  expect(original.bookingState).toBe("pending_payment");
});
test("pay at club starts confirmed without asserting collected funds",()=>{
  expect(buildBookingRevision({...terms,paymentMethod:"pay_at_club"},{...operation,bookingState:"confirmed"},null))
    .toMatchObject({paymentMethod:"pay_at_club",bookingState:"confirmed",revisionNumber:1});
});
test("cross-booking predecessor is rejected",()=>{
  expect(()=>buildBookingRevision(terms,operation,{id,bookingId:randomUUID(),revisionNumber:1})).toThrow("Cross-booking");
});
test("identical contracts and display renames are no-ops but genuine price/contact/policy changes are not",()=>{
  expect(sameRevisionContract(terms,{...terms,locationName:"Renamed club",courtName:"Renamed court"})).toBe(true);
  for(const change of [{totalAmountMinor:5002},{customerEmail:"changed@example.test"},{cancellationNoticeMinutes:0},{endMinute:690}])
    expect(sameRevisionContract(terms,{...terms,...change})).toBe(false);
});
test("bounded pricing evidence explains mixed-rate rounding and freezes rule facts",()=>{
  const rule: PricingRule={id,rule_set_id:id,location_id:id,court_id:id,court_state:"outdoor",weekday:3,starts_at_minute:600,ends_at_minute:630,
    starts_on:null,ends_on:null,price_per_hour_minor:5000,created_at:operation.recordedAt.toISOString(),updated_at:operation.recordedAt.toISOString()};
  const rules=[rule,{...rule,id:randomUUID(),starts_at_minute:630,ends_at_minute:660,price_per_hour_minor:5001}];
  const evidence=capturePricingEvidence(rules,{courtId:id,courtState:"outdoor",date:terms.bookingDate,startMinute:600,endMinute:660,total:5001});
  rules[0].price_per_hour_minor=9000;
  expect(evidence.slots.map(s=>s.hourlyMinor)).toEqual([5000,5001]);
  expect(()=>capturePricingEvidence(rules,{courtId:id,courtState:"outdoor",date:terms.bookingDate,startMinute:600,endMinute:690,total:5001})).toThrow();
  expect(pricingEvidenceSchema.safeParse({...evidence,slots:Array(49).fill(evidence.slots[0])}).success).toBe(false);
});

test("paid extension hold fragments exclude original occupancy and permit a half-hour fragment",()=>{
  const original={courtId:id,date:"2099-10-15",startMinute:600,endMinute:660};
  expect(adjustmentHoldFragments(original,{...original,startMinute:570,endMinute:690})).toEqual([
    {...original,startMinute:570,endMinute:600},{...original,startMinute:660,endMinute:690}]);
  expect(adjustmentHoldFragments(original,original)).toEqual([]);
  const target={...original,courtId:randomUUID()};expect(adjustmentHoldFragments(original,target)).toEqual([target]);
  // Without a coach, court-only behavior is unchanged (no coach on any fragment).
  for(const fragment of [...adjustmentHoldFragments(original,{...original,startMinute:570,endMinute:690},null),
    ...adjustmentHoldFragments(original,target,null)]) expect(fragment).not.toHaveProperty("coachUserId");
});
test("coaching hold fragments protect the coach and never overlap the original lesson's own coach time",()=>{
  const coachUserId=randomUUID(), otherCourt=randomUUID();
  const original={courtId:id,date:"2099-10-15",startMinute:600,endMinute:660};
  // A. Another date, or a non-overlapping time, holds the whole target for court and coach.
  const nextDay={...original,date:"2099-10-16"};
  expect(adjustmentHoldFragments(original,nextDay,coachUserId)).toEqual([{...nextDay,coachUserId}]);
  expect(adjustmentHoldFragments(original,{...nextDay,courtId:otherCourt},coachUserId)).toEqual([{...nextDay,courtId:otherCourt,coachUserId}]);
  const later={...original,courtId:otherCourt,startMinute:720,endMinute:780};
  expect(adjustmentHoldFragments(original,later,coachUserId)).toEqual([{...later,coachUserId}]);
  // B. Same court, overlapping: only the outside pieces, each protecting both resources.
  expect(adjustmentHoldFragments(original,{...original,startMinute:570,endMinute:690},coachUserId)).toEqual([
    {...original,startMinute:570,endMinute:600,coachUserId},{...original,startMinute:660,endMinute:690,coachUserId}]);
  expect(adjustmentHoldFragments(original,original,coachUserId)).toEqual([]);
  // C. Different court, overlapping: the overlap holds the new court only; the rest also holds the coach.
  expect(adjustmentHoldFragments(original,{...original,courtId:otherCourt,startMinute:630,endMinute:690},coachUserId)).toEqual([
    {courtId:otherCourt,date:original.date,startMinute:630,endMinute:660},
    {courtId:otherCourt,date:original.date,startMinute:660,endMinute:690,coachUserId}]);
  expect(adjustmentHoldFragments(original,{...original,courtId:otherCourt,startMinute:540,endMinute:720},coachUserId)).toEqual([
    {courtId:otherCourt,date:original.date,startMinute:540,endMinute:600,coachUserId},
    {courtId:otherCourt,date:original.date,startMinute:600,endMinute:660},
    {courtId:otherCourt,date:original.date,startMinute:660,endMinute:720,coachUserId}]);
  expect(adjustmentHoldFragments(original,{...original,courtId:otherCourt},coachUserId)).toEqual([{...original,courtId:otherCourt}]);
  // Every coach-bearing fragment avoids the original's date and time on any court.
  for(const target of [{...original,startMinute:540,endMinute:720},{...original,courtId:otherCourt,startMinute:570,endMinute:630}])
    for(const fragment of adjustmentHoldFragments(original,target,coachUserId).filter(f=>f.coachUserId))
      expect(fragment.endMinute<=original.startMinute||fragment.startMinute>=original.endMinute).toBe(true);
});
test("coaching contracts carry coach, program and agreed amounts that must match their evidence",()=>{
  const coach=randomUUID(), program=randomUUID();
  const coaching={...terms,totalAmountMinor:15001,coachUserId:coach,coachingProgramId:program,coachName:"Coach",coachingProgramName:"Private",
    pricingEvidence:{...terms.pricingEvidence,coaching:{programId:program,coachUserId:coach,locationId:id,durationMinutes:60,source:"coach" as const,
      amountMinor:10000,currency:"RON" as const,courtRentalIncluded:false,courtRentalMinor:5001,courtAmountMinor:5001}}};
  const original=buildBookingRevision(coaching,operation,null);
  // Later revisions keep the coaching contract and its evidence, never repricing it.
  const confirmed=buildBookingRevision(original,{...operation,id:randomUUID(),kind:"confirmed",bookingState:"confirmed",operationKey:"confirmation",actorScope:"provider"},original);
  expect(confirmed).toMatchObject({coachUserId:coach,coachingProgramId:program,coachName:"Coach",coachingProgramName:"Private",totalAmountMinor:15001,
    pricingEvidence:{coaching:{amountMinor:10000,courtAmountMinor:5001,source:"coach"}}});
  const included={...coaching,totalAmountMinor:10000,pricingEvidence:{...coaching.pricingEvidence,
    coaching:{...coaching.pricingEvidence.coaching,courtRentalIncluded:true,courtAmountMinor:0}}};
  expect(buildBookingRevision(included,operation,null).totalAmountMinor).toBe(10000);
  for(const invalid of [{...coaching,totalAmountMinor:15000},{...coaching,coachName:null},{...coaching,currency:"EUR" as const},
    {...coaching,endMinute:690},{...coaching,coachUserId:randomUUID()},{...terms,coachUserId:coach},
    {...included,pricingEvidence:{...included.pricingEvidence,coaching:{...included.pricingEvidence.coaching,courtAmountMinor:5001}}}])
    expect(()=>buildBookingRevision(invalid,operation,null)).toThrow();
  const semi={...coaching,coachingProgramName:"Semi-private coaching",pricingEvidence:{...coaching.pricingEvidence,
    coaching:{...coaching.pricingEvidence.coaching,participantCount:2 as const}}};
  const semiCreated=buildBookingRevision(semi,operation,null);
  const semiConfirmed=buildBookingRevision(semiCreated,{...operation,id:randomUUID(),kind:"confirmed",bookingState:"confirmed",operationKey:"confirmation",actorScope:"provider"},semiCreated);
  expect(semiConfirmed.coachingProgramName).toBe("Semi-private coaching");
  expect(semiConfirmed.pricingEvidence.coaching?.participantCount).toBe(2);
  expect(semiConfirmed.pricingEvidence).toEqual(semiCreated.pricingEvidence);
  // Group and Junior counts follow their program's range; the snapshot only bounds them to 1–100.
  const withCount=(participantCount:number)=>({...coaching,pricingEvidence:{...coaching.pricingEvidence,coaching:{...coaching.pricingEvidence.coaching,participantCount}}});
  expect(buildBookingRevision(withCount(8),operation,null).pricingEvidence.coaching?.participantCount).toBe(8);
  for(const participantCount of [0,101,2.5]) expect(()=>buildBookingRevision(withCount(participantCount),operation,null)).toThrow();
  // Court bookings remain coachless.
  expect(buildBookingRevision(terms,operation,null)).not.toHaveProperty("pricingEvidence.coaching");
});
