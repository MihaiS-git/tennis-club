import {afterEach,beforeEach,expect,test,vi} from "vitest";
const {claim,release,run}=vi.hoisted(()=>({claim:vi.fn(),release:vi.fn(),run:vi.fn()}));
vi.mock("@/lib/db/transaction",()=>({inTransaction:async(work:(manager:unknown)=>unknown)=>work({})}));
vi.mock("@/lib/db/repositories/job-leases.repository",()=>({claimJobLease:claim,releaseJobLease:release}));
vi.mock("@/lib/payments/recovery",()=>({runPaymentRecovery:run}));
vi.mock("@/lib/logger",()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}}));
import {startPaymentRecoveryScheduler} from "@/lib/payments/recovery-scheduler";
beforeEach(()=>{vi.useFakeTimers();claim.mockResolvedValue(true);release.mockResolvedValue(undefined);run.mockResolvedValue({});});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs();vi.clearAllMocks();
  Reflect.deleteProperty(globalThis,"__paymentRecoveryTimer");});
test("boot schedules recovery with no request or user action, deduplicates startup and repeats",async()=>{
  vi.stubEnv("PAYMENT_RECOVERY_INTERVAL_SECONDS","60");startPaymentRecoveryScheduler();startPaymentRecoveryScheduler();
  expect(run).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(15_000);
  expect(run).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(45_000);expect(run).toHaveBeenCalledTimes(2);
});
test("disabled interval never starts background work",async()=>{
  vi.stubEnv("PAYMENT_RECOVERY_INTERVAL_SECONDS","0");startPaymentRecoveryScheduler();
  await vi.advanceTimersByTimeAsync(120_000);expect(run).not.toHaveBeenCalled();
});
