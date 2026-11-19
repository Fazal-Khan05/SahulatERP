-- Reverses drizzle/0035_counter_sales.sql. Never run automatically. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes. It DELETES the record of every counter
-- sale (which order, invoice and receipt it was, and the buyer's typed name and phone) and which
-- customer is each company's walk-in customer. The orders, invoices, receipts and journals the
-- counter sales made stay where they are, and so does each walk-in customer, as an ordinary
-- customer.

BEGIN;
DROP TRIGGER customers_walk_in ON public.customers;
DROP TRIGGER counter_sales_whole ON public.counter_sales;
DROP TRIGGER receipts_walk_in ON public.receipts;
DROP TRIGGER sales_documents_walk_in ON public.sales_documents;
DROP TRIGGER counter_sales_check ON public.counter_sales;
DROP FUNCTION app.check_walk_in_customer();
DROP FUNCTION app.check_counter_sale_whole();
DROP FUNCTION app.check_walk_in_receipt();
DROP FUNCTION app.check_walk_in_document();
DROP FUNCTION app.check_counter_sale();
DROP FUNCTION app.walk_in_customer();
DROP TABLE public.counter_sales;
DROP TABLE public.walk_in_customers;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795018242585;
COMMIT;
