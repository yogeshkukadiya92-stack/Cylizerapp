import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preparePostgresCliConnection } from "./postgres-connection.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;

if (!command) {
  console.error("Usage: node scripts/run-sql.mjs <migrate|relative-sql-file>");
  process.exit(2);
}

if (!databaseUrl) {
  console.error("DATABASE_URL is required. Refusing to guess a database connection.");
  process.exit(2);
}

const baseArguments = [
  "--no-psqlrc",
  "--set",
  "ON_ERROR_STOP=1",
  "--set",
  "VERBOSITY=terse",
];
const postgresConnection = databaseUrl
  ? preparePostgresCliConnection(databaseUrl)
  : undefined;

function runPsql({ input, file }) {
  const argumentsForPsql = [...baseArguments];
  if (file) {
    argumentsForPsql.push("--file", file);
  }
  argumentsForPsql.push(postgresConnection.databaseUrl);

  const result = spawnSync("psql", argumentsForPsql, {
    encoding: "utf8",
    env: postgresConnection.environment,
    input,
    stdio: file ? "inherit" : ["pipe", "inherit", "inherit"],
  });

  if (result.error?.code === "ENOENT") {
    console.error("psql was not found. Install the PostgreSQL client and retry.");
    process.exit(127);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function isNonTransactionalMigration(sql) {
  return /^--\s*callora:migration-mode\s+nontransactional\s*(?:\r?\n|$)/i.test(sql);
}

function applyMigrations() {
  const migrationsDirectory = join(packageRoot, "migrations");
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();

  if (migrationNames.length === 0) {
    throw new Error("No migrations were found.");
  }

  for (const [index, migrationName] of migrationNames.entries()) {
    const migrationSql = readFileSync(join(migrationsDirectory, migrationName), "utf8");
    const migrationChecksum = checksum(migrationSql);
    const version = migrationName.slice(0, -4);
    const nonTransactional = isNonTransactionalMigration(migrationSql);

    if (index === 0) {
      if (nonTransactional) {
        throw new Error("The bootstrap migration must be transactional.");
      }
      const bootstrap = `
\\set ON_ERROR_STOP on
begin;
select pg_advisory_xact_lock(hashtextextended('callora.schema_migrations', 0));
${migrationSql}
do $migration_guard$
declare
  existing_checksum text;
begin
  select checksum_sha256 into existing_checksum
  from callora.schema_migrations
  where version = ${sqlLiteral(version)};

  if existing_checksum is not null and existing_checksum <> ${sqlLiteral(migrationChecksum)} then
    raise exception 'migration checksum mismatch for %', ${sqlLiteral(version)};
  end if;
end
$migration_guard$;
insert into callora.schema_migrations (version, checksum_sha256)
values (${sqlLiteral(version)}, ${sqlLiteral(migrationChecksum)})
on conflict (version) do nothing;
commit;
`;
      runPsql({ input: bootstrap });
      console.log(`applied bootstrap ${version}`);
      continue;
    }

    if (nonTransactional) {
      const guardedMigration = `
\\set ON_ERROR_STOP on
select pg_advisory_lock(hashtextextended('callora.schema_migrations', 0));
select exists (
  select 1 from callora.schema_migrations where version = ${sqlLiteral(version)}
) as migration_applied \\gset
\\if :migration_applied
  select checksum_sha256 = ${sqlLiteral(migrationChecksum)} as checksum_matches
  from callora.schema_migrations
  where version = ${sqlLiteral(version)} \\gset
  \\if :checksum_matches
    \\echo 'already applied: ${version}'
  \\else
    \\echo 'checksum mismatch: ${version}'
    \\quit 3
  \\endif
\\else
${migrationSql}
  insert into callora.schema_migrations (version, checksum_sha256)
  values (${sqlLiteral(version)}, ${sqlLiteral(migrationChecksum)});
\\endif
select pg_advisory_unlock(hashtextextended('callora.schema_migrations', 0));
`;
      runPsql({ input: guardedMigration });
      continue;
    }

    const guardedMigration = `
\\set ON_ERROR_STOP on
begin;
select pg_advisory_xact_lock(hashtextextended('callora.schema_migrations', 0));
select exists (
  select 1 from callora.schema_migrations where version = ${sqlLiteral(version)}
) as migration_applied \\gset
\\if :migration_applied
  select checksum_sha256 = ${sqlLiteral(migrationChecksum)} as checksum_matches
  from callora.schema_migrations
  where version = ${sqlLiteral(version)} \\gset
  \\if :checksum_matches
    \\echo 'already applied: ${version}'
  \\else
    \\echo 'checksum mismatch: ${version}'
    \\quit 3
  \\endif
\\else
${migrationSql}
  insert into callora.schema_migrations (version, checksum_sha256)
  values (${sqlLiteral(version)}, ${sqlLiteral(migrationChecksum)});
\\endif
commit;
`;
    runPsql({ input: guardedMigration });
  }
}

if (command === "migrate") {
  applyMigrations();
} else {
  const sqlFile = resolve(packageRoot, command);
  if (!sqlFile.startsWith(`${packageRoot}/`)) {
    throw new Error("SQL file must be inside @callora/database.");
  }
  runPsql({ file: sqlFile });
}
