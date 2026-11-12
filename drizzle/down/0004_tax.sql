-- Reverses drizzle/0004_tax.sql. Never run automatically. This DELETES every company's tax
-- categories, tax rates and withholding rules. Run it by hand, as postgres, only after showing it
-- to the founder and getting a yes.

BEGIN;

-- A new company no longer gets tax rows: app.create_tenant as it was in 0000_tenancy.sql.
CREATE OR REPLACE FUNCTION app.create_tenant(p_name text, p_email text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
DECLARE
  v_user uuid := app.current_user_id();
  v_tenant uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'app.user_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.tenants (name, created_by)
    VALUES (btrim(p_name), v_user)
    RETURNING id INTO v_tenant;
  INSERT INTO public.memberships (tenant_id, user_id, email, role, created_by)
    VALUES (v_tenant, v_user, lower(btrim(p_email)), 'owner', v_user);
  RETURN v_tenant;
END $$;

DROP TABLE public.withholding_rules, public.tax_rates, public.tax_categories;
DROP FUNCTION app.seed_tax_defaults(uuid, uuid);
DROP FUNCTION app.check_tax_rate_for_kind();
DROP TYPE public.withholding_base, public.withholding_kind, public.tax_category_kind;

-- The row drizzle-kit wrote for 0004_tax (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794500994114;

COMMIT;
