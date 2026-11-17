-- Reverses drizzle/0030_payroll_employees.sql. Never run automatically. Run it by hand, as
-- postgres, only after showing it to the founder and getting a yes, and never once a real
-- company has entered its employees. It DELETES every employee of every company, their pay,
-- their attendance, and every company's statutory payroll tables.

BEGIN;
DROP TRIGGER tenants_payroll_statutory ON public.tenants;
DROP FUNCTION app.seed_payroll_statutory_for_new_company();
DROP FUNCTION app.seed_payroll_statutory(uuid, uuid);
DROP TABLE public.employee_attendance;
DROP TABLE public.employee_pay;
DROP TABLE public.employees;
DROP TABLE public.salary_tax_slabs;
DROP TABLE public.statutory_rates;
DROP FUNCTION app.check_payroll_row();
DROP FUNCTION app.payroll_is_member(uuid);
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794737467199;
COMMIT;
