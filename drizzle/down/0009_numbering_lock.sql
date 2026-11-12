-- Reverses drizzle/0009_numbering_lock.sql. Never run automatically. It deletes no data: it puts
-- the number function back as 0008_numbering.sql wrote it and drops one check. Run it by hand,
-- as postgres, only after showing it to the founder and getting a yes.

BEGIN;

CREATE OR REPLACE FUNCTION app.next_document_number(p_type text, p_date date) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_year_start date;
  v_locked timestamptz;
  v_code text;
  v_number bigint;
BEGIN
  IF v_tenant IS NULL OR app.tenant_role() = 'auditor' THEN
    RAISE EXCEPTION 'not allowed to number a document' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_type IS NULL OR p_type !~ '^[A-Z]{2}$' OR p_date IS NULL THEN
    RAISE EXCEPTION 'a document number needs a document type and a date' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.year_start, p.locked_at INTO v_year_start, v_locked
    FROM public.fiscal_periods p
    WHERE p.tenant_id = v_tenant AND p.starts_on <= p_date AND p.ends_on >= p_date;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no fiscal period covers %', p_date USING ERRCODE = 'SE001';
  END IF;
  IF v_locked IS NOT NULL THEN
    RAISE EXCEPTION 'the fiscal period of % is locked', p_date USING ERRCODE = 'SE002';
  END IF;
  -- "2627" for a year that starts in July 2026; "2026" for a calendar year.
  v_code := CASE WHEN extract(month FROM v_year_start) = 1
              THEN to_char(v_year_start, 'YYYY')
              ELSE to_char(v_year_start, 'YY') || to_char(v_year_start + interval '1 year', 'YY')
            END;
  INSERT INTO public.number_series (tenant_id, document_type, year_start, year_code, next_number)
    VALUES (v_tenant, p_type, v_year_start, v_code, 2)
    ON CONFLICT (tenant_id, document_type, year_start)
    DO UPDATE SET next_number = public.number_series.next_number + 1, updated_at = now()
    RETURNING next_number - 1 INTO v_number;
  RETURN p_type || '-' || v_code || '-' ||
    CASE WHEN v_number < 100000 THEN lpad(v_number::text, 5, '0') ELSE v_number::text END;
END $$;

ALTER TABLE public.fiscal_periods DROP CONSTRAINT fiscal_periods_start_follows_year;

-- The row drizzle-kit wrote for 0009_numbering_lock (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794522134400;

COMMIT;
