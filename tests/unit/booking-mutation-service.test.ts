import { QueryFailedError } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";
const { transaction } = vi.hoisted(() => ({ transaction:vi.fn() }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction:transaction }));
vi.mock("@/lib/logger", () => ({logger:{error:vi.fn(),info:vi.fn()}}));
import { runBookingReschedule } from "@/lib/bookings/reschedule";
const id="ca000000-0000-4000-8000-000000000001";
const input={id,courtId:id,date:"2099-10-15",startMinute:600,endMinute:660,save:true,
  expectedUpdatedAt:"2099-10-14T10:00:00.123456Z",expectedRevisionId:id,
  expectedTotal:5000,priceAcknowledged:true};
beforeEach(() => { transaction.mockReset(); });
test.each([
  ["23P01","court_reservation_no_overlap",true],
])("maps SQLSTATE %s constraint %s outside the rolled-back transaction", async (code,constraint,conflict) => {
  transaction.mockRejectedValue(new QueryFailedError("command",[],Object.assign(new Error("private database details"),{code,constraint})));
  expect(await runBookingReschedule(input, id)).toEqual({ok:false,message:conflict
    ? "That court is no longer available. The booking has not changed." : "Unable to reschedule this booking. Try again."});
  expect(transaction).toHaveBeenCalledTimes(1);
});
test("maps the coach exclusion to a controlled coach conflict", async () => {
  transaction.mockRejectedValue(new QueryFailedError("command",[],Object.assign(new Error("private database details"),
    {code:"23P01",constraint:"court_reservation_coach_no_overlap"})));
  expect(await runBookingReschedule(input, id)).toEqual({ok:false,
    message:"The coach is no longer available at that time. The booking has not changed."});
});

