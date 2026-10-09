import "server-only";
import "reflect-metadata";

import { DataSource } from "typeorm";

import { PlayerProfileEntity } from "./entities/player-profile.entity";
import { RoleEntity } from "./entities/role.entity";
import { UserRoleEntity } from "./entities/user-role.entity";
import { UserEntity } from "./entities/user.entity";

import { LocationEntity } from "./entities/location.entity";
import { BookingEntity } from "./entities/booking.entity";
import { PaymentAttemptEntity } from "./entities/payment-attempt.entity";
import { PaymentProviderChangeEntity } from "./entities/payment-provider-change.entity";
import { PaymentProviderEventEntity } from "./entities/payment-provider-event.entity";
import { PaymentProviderSettingEntity } from "./entities/payment-provider-setting.entity";
import { PaymentRefundEntity } from "./entities/payment-refund.entity";
import { CourtReservationEntity } from "./entities/court-reservation.entity";
import { CourtEntity } from "./entities/court.entity";
import { CourtCoveragePeriodEntity } from "./entities/court-coverage-period.entity";
import { LocationOpeningHoursEntity } from "./entities/location-opening-hours.entity";
import { LocationPricingRuleEntity } from "./entities/location-pricing-rule.entity";
import { PricingRuleSetEntity } from "./entities/pricing-rule-set.entity";

const entities = {
  BookingEntity, PaymentAttemptEntity, PaymentProviderChangeEntity, PaymentProviderEventEntity,
  PaymentProviderSettingEntity, PaymentRefundEntity, CourtReservationEntity,
  UserEntity, RoleEntity, UserRoleEntity, PlayerProfileEntity, LocationEntity, CourtEntity,
  CourtCoveragePeriodEntity, LocationOpeningHoursEntity, LocationPricingRuleEntity, PricingRuleSetEntity,
};

// TypeORM keys its relation dependency graph by constructor name. Production
// minification can give different entities the same name and create false cycles.
for (const [name, entity] of Object.entries(entities)) {
  Object.defineProperty(entity, "name", { value: name, configurable: true });
}

type ConnectionState = {
  dataSource?: DataSource;
  initialization?: Promise<DataSource>;
};

// Next.js route and action bundles have distinct entity constructors. Keep the
// connection with the module that registered them: TypeORM metadata uses identity.
const connection: ConnectionState = {};

function poolSize(): number {
  const configured = process.env.DATABASE_POOL_MAX?.trim();
  if (!configured) return 2;

  const size = Number(configured);
  if (!/^[1-9]\d*$/.test(configured) || !Number.isSafeInteger(size)) {
    throw new Error("DATABASE_POOL_MAX must be a positive safe integer.");
  }
  return size;
}

// Shared by application persistence and the standalone migration execution; never connects.
export function createDataSource(): DataSource {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required to initialize PostgreSQL persistence.");

  return new DataSource({
    type: "postgres",
    url,
    poolSize: poolSize(),
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    installExtensions: false,
    entities: Object.values(entities),
    migrations: [],
  });
}

export async function getDataSource(): Promise<DataSource> {
  if (connection.initialization) return connection.initialization;
  if (connection.dataSource?.isInitialized) return connection.dataSource;

  const dataSource = createDataSource();

  connection.dataSource = dataSource;
  connection.initialization = dataSource.initialize()
    .catch((error: unknown) => {
      connection.dataSource = undefined;
      throw error;
    })
    .finally(() => {
      connection.initialization = undefined;
    });

  return connection.initialization;
}
