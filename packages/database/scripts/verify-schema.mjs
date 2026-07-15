import { collectSchemaDiagnostics } from "./schema-contract.mjs";

const { errors, facts } = collectSchemaDiagnostics();

if (errors.length > 0) {
  console.error("Callora schema verification failed:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Callora schema verified: ${facts.migrationCount} migrations, ` +
    `${facts.tenantTableCount} FORCE RLS tenant tables, ` +
    `${facts.seededTenantCount} seeded tenants.`,
);
