import "server-only";

import type { DataSource, EntityManager } from "typeorm";

import { getDataSource } from "./data-source";

export async function inTransaction<T>(
  work: (manager: EntityManager) => Promise<T>,
  source?: DataSource,
): Promise<T> {
  const dataSource = source ?? await getDataSource();
  return dataSource.transaction("READ COMMITTED", work);
}

// Independent reads: concurrent on the pooled manager, one at a time on a
// transaction-bound manager, whose single connection must not overlap queries.
export async function readIndependently<T extends readonly unknown[] | []>(
  manager: EntityManager,
  reads: { readonly [K in keyof T]: () => Promise<T[K]> },
): Promise<T> {
  if (!manager.queryRunner) return Promise.all(reads.map((read) => read())) as Promise<T>;
  const results: unknown[] = [];
  for (const read of reads) results.push(await read());
  return results as unknown as T;
}

// Read-only multi-statement reads that must agree with each other: every query
// sees the snapshot taken by its first statement. Takes no row locks.
export async function inReadSnapshot<T>(
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const dataSource = await getDataSource();
  return dataSource.transaction("REPEATABLE READ", async (manager) => {
    await manager.query("SET TRANSACTION READ ONLY");
    return work(manager);
  });
}
