import "server-only";

import type { EntityManager } from "typeorm";
import { JobLeaseEntity } from "../entities/job-lease.entity";

// PostgreSQL time decides lease expiry, so instances with skewed clocks agree.
export async function claimJobLease(manager: EntityManager, input: { name: string; token: string; seconds: number }) {
  await manager.getRepository(JobLeaseEntity).createQueryBuilder().insert()
    .values({ name: input.name }).orIgnore().execute();
  const result = await manager.getRepository(JobLeaseEntity).createQueryBuilder().update()
    .set({ leaseToken: input.token, leaseUntil: () => `clock_timestamp() + make_interval(secs => ${Math.trunc(input.seconds)})`,
      lastStartedAt: () => "clock_timestamp()" })
    .where("name = :name", { name: input.name })
    .andWhere("(lease_token IS NULL OR lease_until <= clock_timestamp())").execute();
  return result.affected === 1;
}

export async function releaseJobLease(manager: EntityManager, input: { name: string; token: string }) {
  await manager.getRepository(JobLeaseEntity).createQueryBuilder().update()
    .set({ leaseToken: null, leaseUntil: null, lastCompletedAt: () => "clock_timestamp()" })
    .where("name = :name AND lease_token = :token", input).execute();
}
