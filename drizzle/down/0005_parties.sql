-- Reverses drizzle/0005_parties.sql. Never run automatically. This DELETES every company's
-- customers, suppliers, contacts and addresses. Run it by hand, as postgres, only after showing
-- it to the founder and getting a yes.

BEGIN;

DROP TABLE public.contacts, public.party_addresses, public.customers, public.suppliers;
DROP TYPE public.supplier_type, public.registration_type, public.province, public.atl_status;

-- The row drizzle-kit wrote for 0005_parties (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794506350253;

COMMIT;
