import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApiScope } from "../commercial-platform.js";
import type { PgPoolLike } from "./types.js";

export interface ApiKeyManager {
  create(organizationId: string, userId: string, name: string, scopes: ApiScope[], at: string): Promise<{ id: string; key: string; prefix: string; name: string; scopes: ApiScope[]; createdAt: string }>;
  list(organizationId: string): Promise<Array<{ id: string; prefix: string; name: string; scopes: ApiScope[]; createdAt: string; lastUsedAt?: string; revokedAt?: string }>>;
  revoke(organizationId: string, id: string, at: string): Promise<boolean>;
}
export class PostgresApiKeyManager implements ApiKeyManager {
  constructor(private readonly pool: PgPoolLike) {}
  private async tenant<T>(organizationId: string, operation: (client: Awaited<ReturnType<PgPoolLike["connect"]>>) => Promise<T>): Promise<T> { const client = await this.pool.connect(); try { await client.query("begin"); await client.query("select set_config('app.current_organization_id',$1,true)", [organizationId]); const result = await operation(client); await client.query("commit"); return result; } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); } }
  async create(organizationId: string, userId: string, name: string, scopes: ApiScope[], at: string) { const id = randomUUID(); const secret = randomBytes(32).toString("base64url"); const prefix = `clr_live_${id.slice(0, 8)}`; const key = `${prefix}.${secret}`; await this.tenant(organizationId, (client) => client.query("insert into callora.api_keys(organization_id,id,name,key_prefix,key_hash,scopes,created_by_user_id,created_at) values($1::uuid,$2::uuid,$3,$4,$5::bytea,$6::text[],$7::uuid,$8::timestamptz)", [organizationId, id, name, prefix, createHash("sha256").update(key).digest(), scopes, userId, at])); return { id, key, prefix, name, scopes, createdAt: at }; }
  async list(organizationId: string) { return this.tenant(organizationId, async (client) => { const result = await client.query<{ id: string; key_prefix: string; name: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null }>("select id,key_prefix,name,scopes,created_at,last_used_at,revoked_at from callora.api_keys where organization_id=$1::uuid order by created_at desc", [organizationId]); return result.rows.map((row) => ({ id: String(row.id), prefix: row.key_prefix, name: row.name, scopes: row.scopes as ApiScope[], createdAt: new Date(row.created_at).toISOString(), ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at).toISOString() } : {}), ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at).toISOString() } : {}) })); }); }
  async revoke(organizationId: string, id: string, at: string) { return this.tenant(organizationId, async (client) => (await client.query("update callora.api_keys set revoked_at=$3::timestamptz where organization_id=$1::uuid and id=$2::uuid and revoked_at is null returning id", [organizationId, id, at])).rowCount === 1); }
}
