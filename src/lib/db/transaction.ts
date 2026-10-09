import "server-only";

import type { EntityManager } from "typeorm";

import { getDataSource } from "./data-source";

export async function inTransaction<T>(
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const dataSource = await getDataSource();
  return dataSource.transaction("READ COMMITTED", work);
}
