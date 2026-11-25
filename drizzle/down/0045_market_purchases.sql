-- Reverses drizzle/0045_market_purchases.sql. Never run automatically. Run it by hand, as
-- postgres, only after showing it to the founder and getting a yes. It DELETES the record of
-- every quick market purchase (which order, goods received note, bill and payment it was, and
-- the seller's typed name, phone and cash memo number) and which supplier is each company's
-- market supplier. The orders, notes, bills, payments, stock and journals the purchases made
-- stay where they are, and so does each market supplier, as an ordinary supplier.

BEGIN;
DROP TRIGGER suppliers_market ON public.suppliers;
DROP TRIGGER supplier_payments_market ON public.supplier_payments;
DROP TRIGGER supplier_bills_market ON public.supplier_bills;
DROP TRIGGER purchase_orders_market ON public.purchase_orders;
DROP TRIGGER market_purchases_whole ON public.market_purchases;
DROP TRIGGER market_purchases_check ON public.market_purchases;
DROP FUNCTION app.check_market_supplier();
DROP FUNCTION app.check_market_payment();
DROP FUNCTION app.check_market_bill();
DROP FUNCTION app.check_market_order();
DROP FUNCTION app.check_market_purchase_whole();
DROP FUNCTION app.check_market_purchase();
DROP FUNCTION app.market_supplier();
DROP TABLE public.market_purchases;
DROP TABLE public.market_suppliers;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795630067800;
COMMIT;
