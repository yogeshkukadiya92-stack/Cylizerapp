import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../migrations/0019_notification_delivery_claims.sql',import.meta.url),'utf8');
test('email delivery claims are concurrent-safe, bounded, and closed to public',()=>{assert.match(sql,/for update skip locked/i);assert.match(sql,/attempt_count<5/i);assert.match(sql,/status='queued'/i);assert.match(sql,/revoke all on function callora\.claim_email_notification_delivery\(text\) from public/i);});
