import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
const migration=readFileSync(new URL('../migrations/0018_report_ready_delivery.sql',import.meta.url),'utf8');
const access=readFileSync(new URL('../access/roles.sql',import.meta.url),'utf8');
test('worker can read only the preference state needed for report-ready delivery',()=>{
  assert.match(migration,/grant select on callora\.notification_preferences to callora_worker/i);
  assert.doesNotMatch(migration,/grant (insert|update|delete).*notification_preferences/i);
  assert.match(access,/grant select on callora\.notification_preferences to callora_worker/i);
});
