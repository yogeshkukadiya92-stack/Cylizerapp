import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const DISPOSABLE_CONFIRMATION = "callora-phase3d-disposable-databases";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export class Phase3dHarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = "Phase3dHarnessError";
  }
}

function fail(message) {
  throw new Phase3dHarnessError(message);
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required.`);
  if (value !== value.trim()) fail(`${name} must not contain leading or trailing whitespace.`);
  return value;
}

function parseBoundedInteger(env, name, fallback, minimum, maximum) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) fail(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function decodeUrlComponent(value, name) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${name} contains invalid URL encoding.`);
  }
}

export function parseDatabaseConnection(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be an absolute PostgreSQL URL.`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash.length > 0) {
    fail(`${name} must use postgres:// or postgresql:// without a fragment.`);
  }
  const username = decodeUrlComponent(url.username, name);
  const password = decodeUrlComponent(url.password, name);
  const databaseName = decodeUrlComponent(url.pathname.slice(1), name);
  if (!username || !password || !url.hostname || !databaseName || databaseName.includes("/")) {
    fail(`${name} must include a username, password, host, and one database name.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(username)) {
    fail(`${name} username must be a simple PostgreSQL identifier.`);
  }
  if (!/(^|[_-])phase3d([_-]|$)/i.test(databaseName) || ["postgres", "template0", "template1"].includes(databaseName)) {
    fail(`${name} must target a database whose name contains a phase3d boundary marker.`);
  }
  for (const parameter of url.searchParams.keys()) {
    const normalized = parameter.toLowerCase();
    if (normalized.startsWith("ssl") || normalized === "requiressl") {
      fail(`${name} must not contain SSL URL parameters; use PHASE3D_DATABASE_SSL_MODE.`);
    }
  }
  const passwordless = new URL(url);
  passwordless.password = "";
  return {
    name,
    rawUrl: value,
    passwordlessUrl: passwordless.toString(),
    username,
    password,
    hostname: url.hostname,
    port: url.port || "5432",
    databaseName,
  };
}

function sameServer(left, right) {
  return left.hostname === right.hostname && left.port === right.port;
}

function isExactLocalhost(hostname) {
  const normalized = hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(normalized);
}

function applyDatabaseSslPolicy(env, connections) {
  const mode = required(env, "PHASE3D_DATABASE_SSL_MODE");
  const allowInsecureLocalhost = env.PHASE3D_ALLOW_INSECURE_LOCALHOST ?? "false";
  if (allowInsecureLocalhost !== "true" && allowInsecureLocalhost !== "false") {
    fail("PHASE3D_ALLOW_INSECURE_LOCALHOST must be exactly true or false.");
  }
  if (mode === "verify-full") {
    if (allowInsecureLocalhost !== "false") {
      fail("PHASE3D_ALLOW_INSECURE_LOCALHOST must be false when PHASE3D_DATABASE_SSL_MODE=verify-full.");
    }
  } else if (mode === "disable") {
    if (allowInsecureLocalhost !== "true" || connections.some((connection) => !isExactLocalhost(connection.hostname))) {
      fail(
        "PHASE3D_DATABASE_SSL_MODE=disable requires PHASE3D_ALLOW_INSECURE_LOCALHOST=true " +
        "and all four URLs on exact localhost/127.0.0.1/::1 hosts.",
      );
    }
  } else {
    fail("PHASE3D_DATABASE_SSL_MODE must be exactly verify-full or disable; libpq prefer/require are not allowed.");
  }
  for (const connection of connections) connection.sslMode = mode;
  return { mode, insecureLocalhostException: mode === "disable" };
}

export function validateHarnessEnvironment(env) {
  if (required(env, "PHASE3D_CONFIRM_DISPOSABLE") !== DISPOSABLE_CONFIRMATION) {
    fail(`PHASE3D_CONFIRM_DISPOSABLE must exactly equal ${DISPOSABLE_CONFIRMATION}.`);
  }
  const migration = parseDatabaseConnection(required(env, "PHASE3D_MIGRATION_DATABASE_URL"), "PHASE3D_MIGRATION_DATABASE_URL");
  const runtime = parseDatabaseConnection(required(env, "PHASE3D_RUNTIME_DATABASE_URL"), "PHASE3D_RUNTIME_DATABASE_URL");
  const restoreMigration = parseDatabaseConnection(
    required(env, "PHASE3D_RESTORE_MIGRATION_DATABASE_URL"),
    "PHASE3D_RESTORE_MIGRATION_DATABASE_URL",
  );
  const restoreRuntime = parseDatabaseConnection(
    required(env, "PHASE3D_RESTORE_RUNTIME_DATABASE_URL"),
    "PHASE3D_RESTORE_RUNTIME_DATABASE_URL",
  );

  if (!sameServer(migration, runtime) || migration.databaseName !== runtime.databaseName) {
    fail("Migration and runtime URLs must target the same Phase 3D database server and database.");
  }
  if (!sameServer(restoreMigration, restoreRuntime) || restoreMigration.databaseName !== restoreRuntime.databaseName) {
    fail("Restore migration and runtime URLs must target the same restore database server and database.");
  }
  if (migration.databaseName === restoreMigration.databaseName && sameServer(migration, restoreMigration)) {
    fail("Source and restore URLs must target different databases.");
  }
  if (sameServer(migration, restoreMigration) && migration.username !== restoreMigration.username) {
    fail("Source and restore databases on the same PostgreSQL server must use the same migration owner role.");
  }
  if (migration.username === runtime.username || restoreMigration.username === restoreRuntime.username) {
    fail("Runtime LOGIN roles must be distinct from migration/owner roles.");
  }
  if (runtime.username !== restoreRuntime.username) {
    fail("Source and restore runtime URLs must use the same dedicated runtime LOGIN role.");
  }

  const sslPolicy = applyDatabaseSslPolicy(
    env,
    [migration, runtime, restoreMigration, restoreRuntime],
  );

  const evidenceDirectory = resolve(env.PHASE3D_EVIDENCE_DIR ?? join(repositoryRoot, "work", "phase3d-evidence"));
  return {
    migration,
    runtime,
    restoreMigration,
    restoreRuntime,
    sslPolicy,
    evidenceDirectory,
    limiterConcurrency: parseBoundedInteger(env, "PHASE3D_LIMITER_CONCURRENCY", 24, 6, 64),
    loadRequests: parseBoundedInteger(env, "PHASE3D_LOAD_REQUESTS", 48, 8, 512),
    loadConcurrency: parseBoundedInteger(env, "PHASE3D_LOAD_CONCURRENCY", 8, 1, 32),
    maximumP95Ms: parseBoundedInteger(env, "PHASE3D_MAX_P95_MS", 3_000, 1, 60_000),
  };
}

export function redactDatabaseText(value, connections = [], extraSecrets = []) {
  let redacted = String(value);
  for (const connection of connections) {
    for (const secret of [connection.rawUrl, connection.password]) {
      if (typeof secret === "string" && secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  for (const secret of extraSecrets) {
    if (typeof secret === "string" && secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  redacted = redacted.replace(/postgres(?:ql)?:\/\/[^\s'\"]+/gi, "[REDACTED_POSTGRES_URL]");
  redacted = redacted.replace(/password\s*[=:]\s*[^\s,;]+/gi, "password=[REDACTED]");
  return redacted;
}

export function connectionEnvironment(connection, overrides = {}) {
  if (connection.sslMode !== "verify-full" && connection.sslMode !== "disable") {
    fail("Validated PHASE3D_DATABASE_SSL_MODE is required before starting a database client.");
  }
  return {
    ...process.env,
    ...overrides,
    PGPASSWORD: connection.password,
    PGCONNECT_TIMEOUT: "10",
    PGSSLMODE: connection.sslMode,
  };
}

function collectChunk(state, chunk) {
  if (state.length >= MAX_CAPTURE_BYTES) return;
  state.value += chunk;
  state.length += Buffer.byteLength(chunk);
  if (state.length > MAX_CAPTURE_BYTES) state.value = state.value.slice(0, MAX_CAPTURE_BYTES);
}

async function runCommand(command, args, {
  cwd = repositoryRoot,
  env = process.env,
  input,
  label = command,
  timeoutMs = 120_000,
  allowFailure = false,
  redactionConnections = [],
} = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = { value: "", length: 0 };
    const stderr = { value: "", length: 0 };
    let timedOut = false;
    let forceKillTimeout;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collectChunk(stdout, chunk));
    child.stderr.on("data", (chunk) => collectChunk(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      if (error.code === "ENOENT") rejectPromise(new Phase3dHarnessError(`${command} was not found in PATH.`));
      else rejectPromise(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      const result = { status: status ?? 1, stdout: stdout.value, stderr: stderr.value };
      if (timedOut) {
        rejectPromise(new Phase3dHarnessError(`${label} exceeded its ${timeoutMs}ms timeout.`));
      } else if (result.status !== 0 && !allowFailure) {
        const details = redactDatabaseText(result.stderr || result.stdout, redactionConnections).trim();
        rejectPromise(new Phase3dHarnessError(`${label} failed with exit ${result.status}${details ? `: ${details}` : "."}`));
      } else {
        resolvePromise(result);
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const PSQL_BASE_ARGUMENTS = [
  "--no-psqlrc",
  "--quiet",
  "--tuples-only",
  "--no-align",
  "--set",
  "ON_ERROR_STOP=1",
  "--set",
  "VERBOSITY=terse",
];

async function runPsql(connection, { sql, file, allowFailure = false, label = "psql", timeoutMs } = {}) {
  const args = [...PSQL_BASE_ARGUMENTS];
  if (file) args.push("--file", file);
  args.push(connection.passwordlessUrl);
  return await runCommand("psql", args, {
    env: connectionEnvironment(connection),
    input: sql,
    allowFailure,
    label,
    timeoutMs,
    redactionConnections: [connection],
  });
}

async function query(connection, sql, options = {}) {
  const result = await runPsql(connection, { sql, ...options });
  return result.stdout.trim();
}

async function runDatabaseScript(connection, command, label) {
  return await runCommand(
    process.execPath,
    ["scripts/run-sql.mjs", command],
    {
      cwd: packageRoot,
      env: connectionEnvironment(connection, {
        DATABASE_URL: connection.passwordlessUrl,
        DATABASE_SSL_MODE: connection.sslMode,
      }),
      label,
      timeoutMs: 180_000,
      redactionConnections: [connection],
    },
  );
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) fail("Unsafe PostgreSQL role identifier.");
  return `"${value.replaceAll('"', '""')}"`;
}

async function checkToolVersion(command) {
  const result = await runCommand(command, ["--version"], { label: `${command} version`, timeoutMs: 10_000 });
  const match = /(?:PostgreSQL\)?\s+)(\d+)(?:\.\d+)?/i.exec(result.stdout || result.stderr);
  if (!match || Number(match[1]) < 15) fail(`${command} 15 or newer is required.`);
  return Number(match[1]);
}

async function assertEmptyDatabase(connection, label) {
  const state = await query(connection, `
select
  (to_regnamespace('callora') is null)::integer::text || '|'
  || (not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname not in ('pg_catalog', 'information_schema')
      and namespace.nspname !~ '^pg_toast'
      and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  ))::integer::text || '|'
  || (not exists (
    select 1 from pg_namespace as namespace
    where namespace.nspname not in ('public', 'pg_catalog', 'information_schema')
      and namespace.nspname !~ '^pg_toast'
  ))::integer::text || '|'
  || (not exists (
    select 1 from pg_extension where extname <> 'plpgsql'
  ))::integer::text;
`, { label });
  if (state !== "1|1|1|1") {
    fail(`${label} is not fully empty; the harness never copies or drops pre-existing user schemas or relations.`);
  }
}

async function grantRuntimeMembership(migration, runtimeUsername) {
  const role = quoteIdentifier(runtimeUsername);
  const runtimeState = await query(migration, `
select case
  when runtime_role.rolcanlogin
    and runtime_role.rolinherit
    and not runtime_role.rolsuper
    and not runtime_role.rolcreatedb
    and not runtime_role.rolcreaterole
    and not runtime_role.rolreplication
    and not runtime_role.rolbypassrls
    and database_definition.datdba <> runtime_role.oid
  then 'ok'
  else 'invalid'
end
from pg_catalog.pg_roles as runtime_role
join pg_catalog.pg_database as database_definition
  on database_definition.datname = current_database()
where runtime_role.rolname = '${runtimeUsername}';
`, { label: "runtime LOGIN role gate" });
  if (runtimeState !== "ok") {
    fail("Runtime must be a distinct INHERIT LOGIN with no owner, superuser, creation, replication, or BYPASSRLS authority.");
  }
  await runPsql(migration, {
    label: "runtime role grant",
    sql: `do $normalize_runtime_api_membership$
begin
  if current_setting('server_version_num')::integer >= 160000 then
    execute 'grant callora_api to ${role} with admin false, inherit true, set true';
  else
    execute 'grant callora_api to ${role}';
    execute 'revoke admin option for callora_api from ${role}';
  end if;
end
$normalize_runtime_api_membership$;
`,
  });
  const membershipState = await query(migration, `
select case
  when count(*) > 0
    and bool_and(
      not coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      and (
        current_setting('server_version_num')::integer < 160000
        or (
          coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
          and coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
        )
      )
    )
  then 'ok'
  else 'invalid'
end
from pg_catalog.pg_auth_members as membership
join pg_catalog.pg_roles as granted_role on granted_role.oid = membership.roleid
join pg_catalog.pg_roles as member_role on member_role.oid = membership.member
where granted_role.rolname = 'callora_api'
  and member_role.rolname = '${runtimeUsername}';
`, { label: "runtime callora_api membership gate" });
  if (membershipState !== "ok") {
    fail("Runtime callora_api membership must be ADMIN false and capability-enabled without an unsafe multi-grantor edge.");
  }
}

async function assertNoForbiddenLoginMemberships(connection, label) {
  const count = await query(connection, `
with recursive actual_memberships(login_oid, granted_role_oid) as (
  select login_role.oid, membership.roleid
  from pg_roles as login_role
  join pg_auth_members as membership on membership.member = login_role.oid
  join pg_roles as directly_granted_role on directly_granted_role.oid = membership.roleid
  join pg_database as database_definition on database_definition.datname = current_database()
  where login_role.rolcanlogin
    and (
      current_setting('server_version_num')::integer < 160000
      or coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
      or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
    )
    and not (
      current_setting('server_version_num')::integer >= 160000
      and login_role.oid = database_definition.datdba
      and directly_granted_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
      and coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      and not coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true)
      and not coalesce((to_jsonb(membership)->>'set_option')::boolean, true)
    )
  union
  select actual_memberships.login_oid, membership.roleid
  from actual_memberships
  join pg_auth_members as membership
    on membership.member = actual_memberships.granted_role_oid
  where current_setting('server_version_num')::integer < 160000
    or coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
    or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
    or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
)
select (
  (
    select count(*)
    from actual_memberships
    join pg_roles as capability_role on capability_role.oid = actual_memberships.granted_role_oid
    where capability_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
  ) + (
    select count(*)
    from pg_roles as capability_role
    where capability_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
      and (
        capability_role.rolcanlogin
        or capability_role.rolsuper
        or capability_role.rolcreatedb
        or capability_role.rolcreaterole
        or capability_role.rolreplication
        or capability_role.rolinherit
        or capability_role.rolbypassrls
      )
  )
)::text;
`, { label });
  if (count !== "0") {
    fail(
      `${label} found ${count || "one or more"} unsafe high-impact role attributes or forbidden LOGIN paths; ` +
      "callora_call_writer must never be reachable by a LOGIN and all callora_pii_migrator capability memberships " +
      "must be revoked before normal release verification (PG16+ ADMIN-only control grants do not confer capability).",
    );
  }
}

function generatedCredentialSql({ requestId, credentialId, fingerprintHex, tokenHashHex }) {
  return `
begin;
set local statement_timeout = '8s';
set local lock_timeout = '5s';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000001';
set local app.current_user_id = '10000000-0000-4000-8000-000000000101';
with timing as (select clock_timestamp() as requested_at)
select request_id::text || '|' || credential_id::text || '|' || lifecycle_state
from timing
cross join lateral callora.prepare_device_credential_request(
  '${requestId}',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000601',
  'redeem',
  decode('${fingerprintHex}', 'hex'),
  '${credentialId}',
  decode('${tokenHashHex}', 'hex'),
  timing.requested_at + interval '10 minutes',
  null,
  '10000000-0000-4000-8000-000000000801',
  timing.requested_at
);
commit;
`;
}

async function verifyCredentialConcurrency(runtime) {
  const attempts = [0, 1].map(() => ({
    requestId: randomUUID(),
    credentialId: randomUUID(),
    fingerprintHex: randomBytes(32).toString("hex"),
    tokenHashHex: randomBytes(32).toString("hex"),
  }));
  const results = await Promise.all(attempts.map((attempt) =>
    runPsql(runtime, {
      sql: generatedCredentialSql(attempt),
      allowFailure: true,
      label: "concurrent credential redemption",
      timeoutMs: 20_000,
    }),
  ));
  const successes = results.filter((result) => result.status === 0);
  const failures = results.filter((result) => result.status !== 0);
  if (successes.length !== 1 || failures.length !== 1) {
    fail("Concurrent credential redemption must produce exactly one commit and one controlled rejection.");
  }
  if (!/pairing code cannot be redeemed/i.test(failures[0].stderr)) {
    fail("Concurrent credential redemption failed for an unexpected reason instead of the controlled consumed-pairing rejection.");
  }
  const state = await query(runtime, `
begin;
set local app.current_organization_id = '10000000-0000-4000-8000-000000000001';
select
  (select count(*) from callora.device_credentials
   where device_id = '10000000-0000-4000-8000-000000000601'
     and credential_type = 'bootstrap' and lifecycle_state = 'active')::text
  || '|'
  || (select count(*) from callora.device_pairing_codes
      where id = '10000000-0000-4000-8000-000000000801'
        and consumed_at is not null)::text;
commit;
`, { label: "credential concurrency state" });
  if (state !== "1|1") fail("Credential concurrency left an invalid active-credential or pairing state.");
  return { attempts: 2, committed: 1, controlledRejection: 1, stateVerified: true };
}

function limiterSql(hashHex, operation, maximumAttempts, windowSeconds) {
  return `select allowed::integer::text || '|' || retry_after_seconds::text
from callora.consume_mobile_rate_limit(
  decode('${hashHex}', 'hex'), '${operation}', ${maximumAttempts}, ${windowSeconds}, clock_timestamp()
);`;
}

async function limiterAttempt(runtime, hashHex, operation, maximumAttempts, windowSeconds) {
  const startedAt = performance.now();
  const output = await query(runtime, limiterSql(hashHex, operation, maximumAttempts, windowSeconds), {
    label: `mobile limiter ${operation}`,
    timeoutMs: 20_000,
  });
  const elapsedMs = performance.now() - startedAt;
  const [allowed, retryAfter] = output.split("|");
  if (!['0', '1'].includes(allowed) || !/^\d+$/.test(retryAfter ?? "")) {
    fail("Mobile limiter returned an invalid result shape.");
  }
  return { allowed: allowed === "1", retryAfterSeconds: Number(retryAfter), elapsedMs };
}

async function resetLimiter(runtime, hashHex, operation) {
  await query(
    runtime,
    `select callora.reset_mobile_rate_limit(decode('${hashHex}', 'hex'), '${operation}');`,
    { label: `mobile limiter reset ${operation}` },
  );
}

async function verifyLimiterConcurrency(runtime, concurrency) {
  const hashHex = randomBytes(32).toString("hex");
  const maximumAttempts = 5;
  const results = await Promise.all(
    Array.from({ length: concurrency }, () =>
      limiterAttempt(runtime, hashHex, "phase3d_concurrency", maximumAttempts, 300),
    ),
  );
  const allowed = results.filter((result) => result.allowed).length;
  const denied = results.length - allowed;
  if (allowed !== maximumAttempts || denied !== concurrency - maximumAttempts) {
    fail("Concurrent mobile limiter attempts did not enforce the exact shared maximum.");
  }
  if (results.filter((result) => !result.allowed).some((result) => result.retryAfterSeconds <= 0)) {
    fail("Denied mobile limiter attempts must return a positive retry interval.");
  }
  await resetLimiter(runtime, hashHex, "phase3d_concurrency");
  return { attempts: concurrency, allowed, denied, reset: true };
}

export function percentile(values, percentage) {
  if (!Array.isArray(values) || values.length === 0 || percentage <= 0 || percentage > 1) {
    fail("percentile requires values and a percentage in (0, 1].");
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentage * ordered.length) - 1)];
}

async function runBounded(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function verifyLimiterLoad(runtime, requestCount, concurrency, maximumP95Ms) {
  const hashes = Array.from({ length: requestCount }, () => randomBytes(32).toString("hex"));
  const results = await runBounded(hashes, concurrency, (hash) =>
    limiterAttempt(runtime, hash, "phase3d_load", 100, 300),
  );
  if (results.some((result) => !result.allowed)) fail("Unique-key limiter load unexpectedly rejected a request.");
  const latencies = results.map((result) => result.elapsedMs);
  const p50Ms = percentile(latencies, 0.5);
  const p95Ms = percentile(latencies, 0.95);
  const maximumMs = Math.max(...latencies);
  if (p95Ms > maximumP95Ms) {
    fail(`Limiter load p95 exceeded PHASE3D_MAX_P95_MS (${Math.round(p95Ms)}ms > ${maximumP95Ms}ms).`);
  }
  await runBounded(hashes, concurrency, (hash) => resetLimiter(runtime, hash, "phase3d_load"));
  return {
    requests: requestCount,
    concurrency,
    p50Ms: Math.round(p50Ms * 100) / 100,
    p95Ms: Math.round(p95Ms * 100) / 100,
    maximumMs: Math.round(maximumMs * 100) / 100,
    thresholdMs: maximumP95Ms,
    failures: 0,
    reset: true,
  };
}

const MANIFEST_SQL = `
select format(
  'select %L || ''|'' || count(*)::text || ''|'' || coalesce(md5(string_agg(md5(to_jsonb(row_data)::text), '''' order by md5(to_jsonb(row_data)::text))), md5('''')) from callora.%I as row_data;',
  relation.relname,
  relation.relname
)
from pg_class as relation
where relation.relnamespace = 'callora'::regnamespace
  and relation.relkind in ('r', 'p', 'S')
order by relation.relname
\gexec
`;

const DETERMINISTIC_MANIFEST_SESSION_SQL = `
set timezone = 'UTC';
`;

const SCHEMA_INVENTORY_SQL = `
with inventory(item) as (
  select concat_ws(
    '|', 'relation', relation.relname, relation.relkind::text,
    relation.relrowsecurity::text, relation.relforcerowsecurity::text,
    case
      when relation.relkind in ('v', 'm') then md5(pg_get_viewdef(relation.oid, true))
      else ''
    end
  )
  from pg_class as relation
  where relation.relnamespace = 'callora'::regnamespace
    and relation.relkind in ('r', 'p', 'v', 'm', 'S')

  union all
  select concat_ws(
    '|', 'column', relation.relname, attribute.attnum::text, attribute.attname,
    format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull::text,
    coalesce(md5(pg_get_expr(column_default.adbin, column_default.adrelid)), '')
  )
  from pg_attribute as attribute
  join pg_class as relation on relation.oid = attribute.attrelid
  left join pg_attrdef as column_default
    on column_default.adrelid = attribute.attrelid
   and column_default.adnum = attribute.attnum
  where relation.relnamespace = 'callora'::regnamespace
    and relation.relkind in ('r', 'p', 'v', 'm', 'S')
    and attribute.attnum > 0
    and not attribute.attisdropped

  union all
  select concat_ws(
    '|', 'constraint', relation.relname, constraint_definition.conname,
    constraint_definition.contype::text,
    md5(pg_get_constraintdef(constraint_definition.oid, true))
  )
  from pg_constraint as constraint_definition
  join pg_class as relation on relation.oid = constraint_definition.conrelid
  where relation.relnamespace = 'callora'::regnamespace

  union all
  select concat_ws(
    '|', 'index', index_relation.relname,
    md5(pg_get_indexdef(index_relation.oid)),
    index_metadata.indisvalid::text,
    index_metadata.indisunique::text
  )
  from pg_index as index_metadata
  join pg_class as index_relation on index_relation.oid = index_metadata.indexrelid
  join pg_class as table_relation on table_relation.oid = index_metadata.indrelid
  where table_relation.relnamespace = 'callora'::regnamespace

  union all
  select concat_ws(
    '|', 'function', procedure_definition.oid::regprocedure::text,
    md5(pg_get_functiondef(procedure_definition.oid))
  )
  from pg_proc as procedure_definition
  where procedure_definition.pronamespace = 'callora'::regnamespace

  union all
  select concat_ws(
    '|', 'policy', relation.relname, policy.polname, policy.polcmd,
    policy.polpermissive::text,
    coalesce(md5(pg_get_expr(policy.polqual, policy.polrelid)), ''),
    coalesce(md5(pg_get_expr(policy.polwithcheck, policy.polrelid)), ''),
    coalesce((
      select string_agg(
        case when role_member.role_oid = 0 then 'public' else policy_role.rolname end,
        ',' order by role_member.role_oid
      )
      from unnest(policy.polroles) as role_member(role_oid)
      left join pg_roles as policy_role on policy_role.oid = role_member.role_oid
    ), '')
  )
  from pg_policy as policy
  join pg_class as relation on relation.oid = policy.polrelid
  where relation.relnamespace = 'callora'::regnamespace

  union all
  select concat_ws(
    '|', 'trigger', relation.relname, trigger_definition.tgname,
    md5(pg_get_triggerdef(trigger_definition.oid, true))
  )
  from pg_trigger as trigger_definition
  join pg_class as relation on relation.oid = trigger_definition.tgrelid
  where relation.relnamespace = 'callora'::regnamespace
    and not trigger_definition.tgisinternal
)
select item from inventory order by item;
`;

async function databaseManifest(connection, label) {
  const output = await query(
    connection,
    `${DETERMINISTIC_MANIFEST_SESSION_SQL}\n${MANIFEST_SQL}`,
    { label, timeoutMs: 120_000 },
  );
  const lines = output.split("\n").filter(Boolean).sort();
  if (lines.length === 0 || !lines.some((line) => line.startsWith("schema_migrations|"))) {
    fail(`${label} did not produce a complete Callora data manifest.`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function databaseDumpArguments(dumpPath, databaseUrl) {
  return [
    "--format=custom",
    "--compress=9",
    "--no-owner",
    "--no-privileges",
    "--schema=callora",
    "--file",
    dumpPath,
    databaseUrl,
  ];
}

async function schemaInventoryFingerprint(connection, label) {
  const output = await query(connection, SCHEMA_INVENTORY_SQL, { label, timeoutMs: 120_000 });
  const lines = output.split("\n").filter(Boolean);
  if (lines.length === 0 || !lines.some((line) => line.startsWith("function|"))) {
    fail(`${label} did not produce a complete Callora schema inventory.`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function migrationCount() {
  return readdirSync(join(packageRoot, "migrations"))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .length;
}

async function verifyMigrationLedger(connection, expectedCount) {
  const count = await query(connection, "select count(*)::text from callora.schema_migrations;", {
    label: "migration ledger count",
  });
  if (count !== String(expectedCount)) {
    fail(`Migration ledger contains ${count || "no"} rows; expected ${expectedCount}.`);
  }
}

async function assertDedicatedMigrationOwner(connection, label) {
  const result = await query(
    connection,
    `select case
       when role_definition.rolsuper
         or role_definition.rolcreatedb
         or not role_definition.rolcreaterole
         or role_definition.rolreplication
         or not role_definition.rolinherit
         or role_definition.rolbypassrls
         or database_definition.datdba <> role_definition.oid
       then 'invalid'
       else 'ok'
     end
     from pg_catalog.pg_roles as role_definition
     join pg_catalog.pg_database as database_definition
       on database_definition.datname = current_database()
     where role_definition.rolname = current_user;`,
    { label },
  );
  if (result !== "ok") {
    fail(`${label} must use an INHERIT, NOCREATEDB, CREATEROLE, NOREPLICATION, non-superuser, non-BYPASSRLS database owner.`);
  }
}

function logStep(message) {
  console.log(`[phase3d] ${message}`);
}

async function runHarness(config) {
  const connections = [config.migration, config.runtime, config.restoreMigration, config.restoreRuntime];
  logStep("checking PostgreSQL client tools");
  const tools = {
    psqlMajor: await checkToolVersion("psql"),
    pgDumpMajor: await checkToolVersion("pg_dump"),
    pgRestoreMajor: await checkToolVersion("pg_restore"),
  };

  const serverVersionNumber = Number(await query(config.migration, "show server_version_num;", { label: "PostgreSQL server version" }));
  if (!Number.isInteger(serverVersionNumber) || serverVersionNumber < 150000) {
    fail("The Phase 3D source database server must be PostgreSQL 15 or newer.");
  }
  const restoreServerVersionNumber = Number(await query(config.restoreMigration, "show server_version_num;", { label: "restore server version" }));
  if (!Number.isInteger(restoreServerVersionNumber) || restoreServerVersionNumber < 150000) {
    fail("The Phase 3D restore database server must be PostgreSQL 15 or newer.");
  }
  await assertDedicatedMigrationOwner(config.migration, "source migration role gate");
  await assertDedicatedMigrationOwner(config.restoreMigration, "restore migration role gate");

  logStep("confirming both disposable databases are empty");
  await assertEmptyDatabase(config.migration, "source Phase 3D database");
  await assertEmptyDatabase(config.restoreMigration, "restore Phase 3D database");

  const expectedMigrationCount = migrationCount();
  logStep("applying migrations and replaying the checksum-locked runner");
  await runDatabaseScript(config.migration, "migrate", "initial migration application");
  await runDatabaseScript(config.migration, "migrate", "migration replay");
  await verifyMigrationLedger(config.migration, expectedMigrationCount);

  logStep("applying least-privilege grants and deterministic integration seed");
  await runDatabaseScript(config.migration, "access/roles.sql", "database access grants");
  await runDatabaseScript(config.migration, "access/roles.sql", "database access grant replay");
  await grantRuntimeMembership(config.migration, config.runtime.username);
  await assertNoForbiddenLoginMemberships(config.migration, "source capability-role audit");
  await runDatabaseScript(config.migration, "seed/dev.sql", "deterministic development seed");

  logStep("proving non-owner FORCE-RLS isolation through the runtime LOGIN role");
  await runPsql(config.runtime, {
    file: join(packageRoot, "tests", "phase3d-runtime.sql"),
    label: "non-owner FORCE-RLS verification",
    timeoutMs: 120_000,
  });
  await runPsql(config.runtime, {
    file: join(packageRoot, "tests", "live-schema.sql"),
    label: "live schema catalog verification",
    timeoutMs: 120_000,
  });
  await runPsql(config.runtime, {
    file: join(packageRoot, "tests", "phase3d-pii-catalog.sql"),
    label: "exact PII index and function catalog verification",
    timeoutMs: 120_000,
  });

  logStep("running concurrent credential and shared-limiter proofs");
  const credentialConcurrency = await verifyCredentialConcurrency(config.runtime);
  const limiterConcurrency = await verifyLimiterConcurrency(config.runtime, config.limiterConcurrency);
  const limiterLoad = await verifyLimiterLoad(
    config.runtime,
    config.loadRequests,
    config.loadConcurrency,
    config.maximumP95Ms,
  );

  const sourceManifest = await databaseManifest(config.migration, "source data manifest");
  const sourceSchemaInventory = await schemaInventoryFingerprint(config.migration, "source schema inventory");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "callora-phase3d-"));
  const dumpPath = join(temporaryDirectory, "callora-phase3d.dump");
  let backup;
  try {
    logStep("creating an owner-free custom-format backup");
    await runCommand(
      "pg_dump",
      databaseDumpArguments(dumpPath, config.migration.passwordlessUrl),
      {
        env: connectionEnvironment(config.migration),
        label: "Phase 3D database backup",
        timeoutMs: 180_000,
        redactionConnections: connections,
      },
    );
    if (!existsSync(dumpPath) || statSync(dumpPath).size === 0) fail("pg_dump did not create a non-empty backup artifact.");
    const dumpBytes = readFileSync(dumpPath);
    backup = {
      bytes: dumpBytes.length,
      sha256: createHash("sha256").update(dumpBytes).digest("hex"),
    };

    logStep("restoring into the separate empty database and replaying verification");
    // The schema-scoped backup intentionally excludes public and every other
    // namespace. pgcrypto is the sole external dependency of the Callora
    // schema, so provision it explicitly only after the empty-target gate.
    await query(
      config.restoreMigration,
      "create extension if not exists pgcrypto;",
      { label: "restore pgcrypto prerequisite" },
    );
    await runCommand(
      "pg_restore",
      ["--exit-on-error", "--no-owner", "--no-privileges", "--dbname", config.restoreMigration.passwordlessUrl, dumpPath],
      {
        env: connectionEnvironment(config.restoreMigration),
        label: "Phase 3D database restore",
        timeoutMs: 180_000,
        redactionConnections: connections,
      },
    );
    await runDatabaseScript(config.restoreMigration, "migrate", "restored migration replay");
    await runDatabaseScript(config.restoreMigration, "access/roles.sql", "restored access grants");
    await runDatabaseScript(config.restoreMigration, "access/roles.sql", "restored access grant replay");
    await grantRuntimeMembership(config.restoreMigration, config.restoreRuntime.username);
    await assertNoForbiddenLoginMemberships(config.restoreMigration, "restored capability-role audit");
    await verifyMigrationLedger(config.restoreMigration, expectedMigrationCount);
    await runPsql(config.restoreRuntime, {
      file: join(packageRoot, "tests", "phase3d-runtime.sql"),
      label: "restored non-owner FORCE-RLS verification",
      timeoutMs: 120_000,
    });
    await runPsql(config.restoreRuntime, {
      file: join(packageRoot, "tests", "live-schema.sql"),
      label: "restored live schema catalog verification",
      timeoutMs: 120_000,
    });
    await runPsql(config.restoreRuntime, {
      file: join(packageRoot, "tests", "phase3d-pii-catalog.sql"),
      label: "restored exact PII index and function catalog verification",
      timeoutMs: 120_000,
    });
    const restoreManifest = await databaseManifest(config.restoreMigration, "restored data manifest");
    if (restoreManifest !== sourceManifest) fail("Restored Callora table counts or row fingerprints differ from the source backup.");
    const restoreSchemaInventory = await schemaInventoryFingerprint(
      config.restoreMigration,
      "restored schema inventory",
    );
    if (restoreSchemaInventory !== sourceSchemaInventory) {
      fail("Restored Callora functions, constraints, policies, triggers, indexes, or relation definitions differ from the source.");
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  mkdirSync(config.evidenceDirectory, { recursive: true, mode: 0o700 });
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "passed",
    postgres: {
      sourceServerVersionNumber: serverVersionNumber,
      restoreServerVersionNumber,
      clients: tools,
      migrationCount: expectedMigrationCount,
      migrationReplay: true,
      runtimeNonOwnerForceRls: true,
      forbiddenCapabilityLoginMemberships: 0,
      piiCatalogVerified: true,
      sslPolicy: config.sslPolicy.mode,
      insecureLocalhostException: config.sslPolicy.insecureLocalhostException,
    },
    credentialConcurrency,
    limiterConcurrency,
    limiterLoad,
    backupRestore: {
      dumpBytes: backup.bytes,
      dumpSha256: backup.sha256,
      dumpScope: "callora",
      ownerPrivilegesExcluded: true,
      restoredRuntimeRlsVerified: true,
      sourceRestoreManifestMatch: true,
      sourceRestoreSchemaInventoryMatch: true,
      temporaryDumpDeleted: true,
    },
  };
  const evidencePath = join(config.evidenceDirectory, "phase3d-database-evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  logStep("all live database gates passed; sanitized JSON evidence written");
  console.log(JSON.stringify({ status: "passed", evidencePath }, null, 2));
  return evidence;
}

async function main() {
  if (process.argv.length !== 2) fail("phase3d-live.mjs does not accept command-line secrets or positional arguments.");
  const config = validateHarnessEnvironment(process.env);
  await runHarness(config);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    let connections = [];
    try {
      for (const name of [
        "PHASE3D_MIGRATION_DATABASE_URL",
        "PHASE3D_RUNTIME_DATABASE_URL",
        "PHASE3D_RESTORE_MIGRATION_DATABASE_URL",
        "PHASE3D_RESTORE_RUNTIME_DATABASE_URL",
      ]) {
        if (process.env[name]) connections.push(parseDatabaseConnection(process.env[name], name));
      }
    } catch {
      connections = [];
    }
    console.error(`Phase 3D database verification failed: ${redactDatabaseText(error instanceof Error ? error.message : error, connections)}`);
    process.exitCode = 1;
  });
}
