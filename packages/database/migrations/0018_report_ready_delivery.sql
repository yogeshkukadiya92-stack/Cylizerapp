begin;

-- The report worker consults only the authenticated requester's export-ready
-- channel preferences while materializing completion delivery state. RLS still
-- requires the trusted tenant context set by the worker transaction.
grant select on callora.notification_preferences to callora_worker;

commit;
