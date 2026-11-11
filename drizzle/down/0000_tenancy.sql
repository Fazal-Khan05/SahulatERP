-- Reverses drizzle/0000_tenancy.sql. Never run automatically: drizzle-kit only applies the files
-- listed in drizzle/meta/_journal.json. This DELETES every tenant, membership, branch, invitation
-- and audit row. Run it by hand, as postgres, only after showing it to the founder and getting a yes.

BEGIN;

DROP TABLE public.audit_log, public.invitations, public.branches, public.memberships, public.tenants;
DROP TYPE public.invitation_status, public.member_role;

DROP FUNCTION app.create_tenant(text, text);
DROP FUNCTION app.member_tenant_ids();
DROP FUNCTION app.tenant_branch_ids();
DROP FUNCTION app.tenant_role();
DROP FUNCTION app.tenant_id();
DROP FUNCTION app.current_user_id();
DROP SCHEMA app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;

REVOKE USAGE ON SCHEMA public FROM app_runtime;
DROP ROLE app_runtime;

DELETE FROM drizzle.__drizzle_migrations;

COMMIT;
