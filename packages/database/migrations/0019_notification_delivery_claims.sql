begin;

create or replace function callora.claim_email_notification_delivery(p_worker_id text)
returns table (organization_id uuid, delivery_id uuid, user_id uuid, recipient_email text, event_key text, payload jsonb, attempt_count smallint)
language sql security definer set search_path = callora, pg_temp as $$
  update callora.notification_deliveries delivery set status='processing',attempt_count=delivery.attempt_count+1,
    locked_by=p_worker_id,locked_at=statement_timestamp(),updated_at=statement_timestamp()
  from callora.users recipient
  where (delivery.organization_id,delivery.id)=(select candidate.organization_id,candidate.id from callora.notification_deliveries candidate
    where candidate.channel='email' and candidate.status='queued' and candidate.available_at<=statement_timestamp() and candidate.attempt_count<5
    order by candidate.available_at,candidate.created_at,candidate.id for update skip locked limit 1)
    and recipient.organization_id=delivery.organization_id and recipient.id=delivery.user_id
  returning delivery.organization_id,delivery.id,delivery.user_id,recipient.email,delivery.event_key,delivery.payload,delivery.attempt_count;
$$;

revoke all on function callora.claim_email_notification_delivery(text) from public;
grant execute on function callora.claim_email_notification_delivery(text) to callora_worker;

commit;
