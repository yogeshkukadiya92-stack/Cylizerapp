import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { findMissingForeignKeyIndexes, packageRoot, readSchemaFiles } from '../scripts/schema-contract.mjs'

const sql = readFileSync(`${packageRoot}/migrations/0016_report_automation.sql`, 'utf8')
const tables = ['saved_report_views', 'report_schedules', 'notification_preferences', 'report_export_jobs']

test('Phase 5A tables are tenant-owned, FORCE RLS protected, and closed to PUBLIC', () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`create table callora\\.${table} \\([\\s\\S]*?organization_id uuid not null`, 'i'))
    assert.match(sql, new RegExp(`alter table callora\\.${table} force row level security`, 'i'))
    assert.match(sql, new RegExp(`create policy ${table}_tenant`, 'i'))
  }
  assert.match(sql, /revoke all on callora\.saved_report_views[\s\S]*from public/i)
})

test('Phase 5A foreign keys remain tenant-first and indexed', () => {
  const missing = findMissingForeignKeyIndexes(readSchemaFiles().schemaSql).filter(({ tableName }) => tables.includes(tableName))
  assert.deepEqual(missing, [])
  for (const match of sql.matchAll(/foreign key\s*\(([^)]+)\)/gi)) {
    assert.equal(match[1].split(',')[0].trim().toLowerCase(), 'organization_id')
  }
})

test('export jobs use bounded retries, opaque expiring downloads, and SKIP LOCKED claims', () => {
  assert.match(sql, /attempts between 0 and 5/i)
  assert.match(sql, /download_token_hash bytea/i)
  assert.match(sql, /download_expires_at timestamptz/i)
  assert.match(sql, /for update skip locked/i)
  assert.match(sql, /revoke all on function callora\.claim_report_export_job\(text, integer\) from public/i)
  assert.match(sql, /grant execute on function callora\.claim_report_export_job\(text, integer\) to callora_worker/i)
})

test('schedule periods are de-duplicated and notification channels are explicit', () => {
  assert.match(sql, /report_schedules_period_once_key unique \(organization_id, id, last_period_key\)/i)
  assert.match(sql, /event_key in \('missed_call','overdue_follow_up','device_offline','import_completed','export_ready'\)/i)
  assert.match(sql, /email_enabled boolean not null/i)
  assert.match(sql, /in_app_enabled boolean not null/i)
})
