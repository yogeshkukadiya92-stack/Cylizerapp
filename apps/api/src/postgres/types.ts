import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { CallPiiCrypto } from "../call-pii-crypto.js";

/** The small structural surface used by the repository and its scripted tests. */
export interface PgClientLike {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(error?: Error | boolean): void;
}

/** A real pg.Pool is structurally compatible; tests can provide a scripted pool. */
export interface PgPoolLike {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

// Compile-time guards: changes to @types/pg must not silently break the adapter.
type PoolIsCompatible = Pool extends PgPoolLike ? true : false;
type ClientIsCompatible = PoolClient extends PgClientLike ? true : false;
export const pgStructuralCompatibility: readonly [PoolIsCompatible, ClientIsCompatible] = [true, true];

export interface PostgresRepositoryOptions {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  callPiiCrypto?: CallPiiCrypto;
}

export interface ExternalIdentity {
  issuer: string;
  subject: string;
  organizationId: string;
}

export interface OutboxEventRecord {
  id: string;
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  availableAt: string;
  attemptCount: number;
  lockedAt?: string;
  lockedBy?: string;
  deliveredAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
