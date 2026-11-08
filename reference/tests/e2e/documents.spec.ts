import { expect, test, type Page } from '@playwright/test';
import { QA_TENANT } from '../../scripts/create-qa-tenant';

// Runs on the QA tenant after onboarding.spec.ts; completes setup itself if it runs first.
async function signIn(page: Page) {
  await page.goto(`/?tenant=${QA_TENANT}`);
  if (await page.getByRole('heading', { name: 'Welcome back' }).isVisible()) {
    await page.getByLabel('Email address').fill(process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@sahulaterp.com');
    await page.locator('input[type="password"]').fill(process.env.BOOTSTRAP_OWNER_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in securely' }).click();
  }
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: /^(Overview|Company)/ }).first().waitFor({ timeout: 60_000 });
  const post = async (type: string, payload: Record<string, unknown>) => {
    const data = { type, payload, idempotencyKey: `docs-setup-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
    let response = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data });
    if (response.status() >= 500) response = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data });
    return response;
  };
  if (await page.getByRole('heading', { name: 'Company', exact: true }).isVisible()) {
    await post('save_company', { name: 'QA Trading Company', address: '12 Jodia Bazar, Karachi' });
    await post('set_modules', { enabled: ['sales', 'purchasing', 'inventory', 'collections', 'commissions', 'reports'] });
    await post('complete_setup', {});
  } else {
    const current = await (await page.request.get(`/api/workspace?tenant=${QA_TENANT}`)).json();
    await post('set_modules', { enabled: Array.from(new Set([...current.workspace.modules, 'sales', 'purchasing', 'inventory', 'collections'])) });
  }
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  return post;
}
const openModule = (page: Page, module: string) => page.locator('button.nav-item').filter({ hasText: module }).click();

test('sales and purchase cycles with partial conversions, payments and returns', async ({ page }) => {
  test.setTimeout(300_000);
  if (!process.env.BOOTSTRAP_OWNER_PASSWORD) test.skip(true, 'Owner credentials are unavailable.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const post = await signIn(page);
  const stamp = Date.now().toString().slice(-6);

  // Master data through the API: a customer, a supplier, two products with opening stock.
  const customer = (await (await post('save_party', { name: `Cycle Customer ${stamp}`, type: 'customer', city: 'Karachi', email: '', taxId: '', registered: false, creditLimit: '10000000', terms: 15, customerClass: 'Retailer' })).json()).recordId as string;
  const supplier = (await (await post('save_party', { name: `Cycle Supplier ${stamp}`, type: 'supplier', city: 'Shenzhen', email: '', taxId: '', registered: false, creditLimit: '0', terms: 60, customerClass: 'Importer' })).json()).recordId as string;
  const itemA = (await (await post('save_item', { sku: `CYA-${stamp}`, name: `Cycle Panel ${stamp}`, category: 'General', hsCode: '', unit: 'pcs', price: '1000', cost: '600', weight: '1', volume: '1', reorderLevel: 0 })).json()).recordId as string;
  const itemB = (await (await post('save_item', { sku: `CYB-${stamp}`, name: `Cycle Board ${stamp}`, category: 'General', hsCode: '', unit: 'pcs', price: '500', cost: '300', weight: '1', volume: '1', reorderLevel: 0 })).json()).recordId as string;
  const warehouses = (await (await page.request.get(`/api/workspace?tenant=${QA_TENANT}`)).json()).workspace.warehouses as { id: string }[];
  const warehouseId = warehouses[0].id;
  expect((await post('bulk_stock_increase', { warehouseId, date: '2026-10-01', purpose: 'opening_stock', reason: 'QA opening', lines: [{ itemId: itemA, quantity: '20', cost: '600' }, { itemId: itemB, quantity: '20', cost: '300' }] })).status()).toBe(200);
  await page.reload();
  await page.waitForLoadState('networkidle');

  // ---- A brand-new customer typed straight into an invoice is confirmed, then created ----
  await openModule(page, 'Sales');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  const walkIn = page.getByRole('dialog', { name: 'New sales invoice' });
  await walkIn.getByLabel('Customer').fill(`Walk-in ${stamp}`);
  await expect(walkIn.getByText(/New customer\. You can choose whether to save them/)).toBeVisible();
  await walkIn.getByLabel('New customer city').fill('Hyderabad');
  await walkIn.getByLabel('Line 1 product').selectOption(itemB);
  await walkIn.getByLabel('Line 1 quantity').fill('1');
  await walkIn.getByRole('button', { name: 'Save draft' }).click();
  const confirmCustomer = page.getByRole('dialog', { name: 'Save customer?' });
  await expect(confirmCustomer).toContainText(`Walk-in ${stamp}`);
  await confirmCustomer.getByRole('button', { name: 'Yes, save customer' }).click();
  await expect(walkIn).toHaveCount(0);
  await expect(page.locator('tbody tr').filter({ hasText: `Walk-in ${stamp}` }).first()).toContainText('draft');
  await page.getByRole('tab', { name: 'Customers' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: `Walk-in ${stamp}` }).first()).toContainText('Hyderabad');
  await page.getByRole('tab', { name: 'Documents' }).click();

  // Choosing not to save the customer still saves the invoice under the shared walk-in account, showing the typed name.
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  const oneOff = page.getByRole('dialog', { name: 'New sales invoice' });
  await oneOff.getByLabel('Customer').fill(`Counter sale ${stamp}`);
  await oneOff.getByLabel('Line 1 product').selectOption(itemB);
  await oneOff.getByLabel('Line 1 quantity').fill('1');
  await oneOff.getByRole('button', { name: 'Save draft' }).click();
  await page.getByRole('dialog', { name: 'Save customer?' }).getByRole('button', { name: 'No, don’t save' }).click();
  await expect(oneOff).toHaveCount(0);
  await expect(page.locator('tbody tr').filter({ hasText: `Counter sale ${stamp}` }).first()).toContainText('draft');
  await page.getByRole('tab', { name: 'Customers' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: `Counter sale ${stamp}` })).toHaveCount(0);
  await expect(page.locator('tbody tr').filter({ hasText: 'Walk-in customer' }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Documents' }).click();

  // ---- Sales: two-line quotation through the editor ----
  await page.getByRole('button', { name: 'New quotation' }).click();
  const editor = page.getByRole('dialog', { name: 'New quotation' });
  await editor.getByLabel('Customer').fill(`Cycle Customer ${stamp}`);
  await expect(editor.getByLabel('Due date')).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await editor.getByLabel('Line 1 product').selectOption(itemA);
  await expect(editor.getByLabel('Line 1 price')).toHaveValue('1000');
  await editor.getByLabel('Line 1 quantity').fill('10');
  await editor.getByRole('button', { name: 'Add line' }).click();
  await editor.getByLabel('Line 2 product').selectOption(itemB);
  await editor.getByLabel('Line 2 quantity').fill('4');
  await editor.getByLabel('Line 2 discount').fill('10');
  await expect(editor.locator('.editor-totals')).toContainText('Rs 11,800'); // 10,000 + 1,800 net
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(editor).toHaveCount(0);
  const quoteRow = page.locator('tbody tr').filter({ hasText: `Cycle Customer ${stamp}` }).filter({ hasText: 'Quotation' }).first();
  await expect(quoteRow).toContainText('draft');
  await quoteRow.getByRole('button', { name: 'Submit' }).click();
  await expect(quoteRow).toContainText('submitted');

  // Convert quotation → order (all), order → delivery (partial 6 of 10 on line 1 only)
  await quoteRow.getByRole('button', { name: /^Convert / }).click();
  await page.getByRole('dialog', { name: /Sales order from/ }).getByRole('button', { name: 'Create sales order' }).click();
  const orderRow = page.locator('tbody tr').filter({ hasText: `Cycle Customer ${stamp}` }).filter({ hasText: 'Sales order' }).first();
  await orderRow.getByRole('button', { name: 'Submit' }).click();
  await expect(orderRow).toContainText('submitted');
  await orderRow.getByRole('button', { name: /^Convert / }).click();
  const deliver = page.getByRole('dialog', { name: /Delivery note from/ });
  await deliver.getByLabel(`Cycle Panel ${stamp} quantity this time`).fill('6');
  await deliver.getByLabel(`Cycle Board ${stamp} quantity this time`).fill('0');
  await deliver.getByRole('button', { name: 'Create delivery note' }).click();
  const deliveryRow = page.locator('tbody tr').filter({ hasText: `Cycle Customer ${stamp}` }).filter({ hasText: 'Delivery note' }).first();
  await deliveryRow.getByRole('button', { name: 'Submit' }).click();
  await expect(deliveryRow).toContainText('submitted');
  // Over-conversion is refused in the dialog
  await orderRow.getByRole('button', { name: /^Convert / }).click();
  const deliver2 = page.getByRole('dialog', { name: /Delivery note from/ });
  await expect(deliver2.getByLabel(`Cycle Panel ${stamp} quantity this time`)).toHaveValue('4');
  await deliver2.getByLabel(`Cycle Panel ${stamp} quantity this time`).fill('5');
  await deliver2.getByRole('button', { name: 'Create delivery note' }).click();
  await expect(deliver2.getByRole('alert')).toContainText('only 4 remaining');
  await deliver2.getByRole('button', { name: 'Cancel' }).click();
  // Invoice the delivery, submit, then open the invoice and check the chain
  await deliveryRow.getByRole('button', { name: /^Convert / }).click();
  await page.getByRole('dialog', { name: /Sales invoice from/ }).getByRole('button', { name: 'Create sales invoice' }).click();
  const invoiceRow = page.locator('tbody tr').filter({ hasText: `Cycle Customer ${stamp}` }).filter({ hasText: 'Sales invoice' }).first();
  await invoiceRow.getByRole('button', { name: 'Submit' }).click();
  await expect(invoiceRow).toContainText('submitted');
  await invoiceRow.getByRole('button', { name: /^View invoice/ }).click();
  const details = page.getByRole('dialog', { name: /^Invoice / });
  await expect(details.getByText('Document chain')).toBeVisible();
  // A new company has no default tax rate (nothing statutory is hard-coded), so 6 × 1000 with 0% tax.
  await expect(details.locator('.invoice-balance')).toContainText('Rs 6,000');
  const invoiceNumber = (await details.getByRole('heading', { name: /^Invoice / }).innerText()).replace('Invoice ', '');
  await details.getByRole('button', { name: 'Close dialog' }).click();

  // ---- Receipt allocated across two invoices (this one and a direct second invoice) ----
  await page.getByRole('button', { name: 'New invoice' }).click();
  const inv2 = page.getByRole('dialog', { name: 'New sales invoice' });
  await inv2.getByLabel('Customer').fill(`Cycle Customer ${stamp}`);
  await inv2.getByLabel('Line 1 product').selectOption(itemB);
  await inv2.getByLabel('Line 1 quantity').fill('2');
  await inv2.getByRole('button', { name: 'Save draft' }).click();
  const inv2Row = page.locator('tbody tr').filter({ hasText: `Cycle Customer ${stamp}` }).filter({ hasText: 'Sales invoice' }).filter({ hasText: 'draft' }).first();
  await inv2Row.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: `Cycle Customer ${stamp}` }).filter({ hasText: 'Sales invoice' }).filter({ hasText: 'draft' })).toHaveCount(0);
  await openModule(page, 'Collections');
  await page.getByRole('button', { name: 'Record receipt' }).first().click();
  const receipt = page.getByRole('dialog', { name: 'Record customer receipt' });
  await receipt.getByLabel('Customer').selectOption(customer);
  await expect(receipt.locator('tbody tr')).toHaveCount(2);
  await receipt.getByLabel('Amount to allocate oldest first').fill('8000');
  await expect(receipt.getByLabel(`Allocate to ${invoiceNumber}`)).toHaveValue('6000.0000');
  await receipt.getByRole('button', { name: 'Save receipt' }).click();
  await expect(receipt).toHaveCount(0);
  await expect(page.getByText('Payment posted and allocated.')).toBeVisible();

  // ---- Return 1 panel on the first invoice ----
  await openModule(page, 'Sales');
  await page.getByLabel('Search invoices').fill(invoiceNumber);
  await page.locator('tbody tr').first().getByRole('button', { name: /^View invoice/ }).click();
  await page.getByRole('dialog', { name: /^Invoice / }).getByRole('button', { name: 'Return' }).click();
  const ret = page.getByRole('dialog', { name: /Customer return/ });
  await ret.getByLabel(`Cycle Panel ${stamp} return quantity`).fill('1');
  await ret.getByLabel('Return reason').fill('Damaged');
  await ret.getByRole('button', { name: 'Post return' }).click();
  await expect(page.getByText('Return posted. Stock, balances and commission updated.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^Invoice / }).locator('.invoice-balance')).toContainText('Customer credit');
  await page.getByRole('dialog', { name: /^Invoice / }).getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Clear filters' }).click();

  // ---- Purchasing: USD order → receipt → bill → payment at a different rate ----
  await openModule(page, 'Purchasing');
  await page.getByRole('button', { name: 'New purchase order' }).first().click();
  const po = page.getByRole('dialog', { name: 'New purchase order' });
  await po.getByLabel('Supplier').fill(`Cycle Supplier ${stamp}`);
  await po.getByLabel('Exchange rate').fill('280');
  await po.getByLabel('Line 1 product').selectOption(itemA);
  await expect(po.getByLabel('Line 1 price')).toHaveValue('600');
  await po.getByLabel('Line 1 price').fill('2');
  await po.getByLabel('Line 1 quantity').fill('100');
  await expect(po.locator('.editor-totals')).toContainText('56,000'); // 200 USD × 280
  await po.getByRole('button', { name: 'Save draft' }).click();
  const poRow = page.locator('tbody tr').filter({ hasText: `Cycle Supplier ${stamp}` }).filter({ hasText: 'Purchase order' }).first();
  await poRow.getByRole('button', { name: 'Submit' }).click();
  await expect(poRow).toContainText('submitted');
  await poRow.getByRole('button', { name: /^Convert / }).click();
  await page.getByRole('dialog', { name: /Goods receipt note from/ }).getByRole('button', { name: 'Create goods receipt note' }).click();
  const grnRow = page.locator('tbody tr').filter({ hasText: `Cycle Supplier ${stamp}` }).filter({ hasText: 'Goods receipt note' }).first();
  await grnRow.getByRole('button', { name: 'Submit' }).click();
  await expect(grnRow).toContainText('submitted');
  await grnRow.getByRole('button', { name: /^Convert / }).click();
  await page.getByRole('dialog', { name: /Supplier bill from/ }).getByRole('button', { name: 'Create supplier bill' }).click();
  const billRow = page.locator('tbody tr').filter({ hasText: `Cycle Supplier ${stamp}` }).filter({ hasText: 'Supplier bill' }).first();
  await billRow.getByRole('button', { name: 'Submit' }).click();
  await expect(billRow).toContainText('submitted');
  await page.getByRole('tab', { name: 'Supplier payments' }).click();
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  const pay = page.getByRole('dialog', { name: 'Record supplier payment' });
  await pay.getByLabel('Supplier').selectOption(supplier);
  await pay.getByLabel('Amount to allocate oldest first').fill('200');
  await pay.getByLabel('PKR paid').fill('57000');
  await pay.getByRole('button', { name: 'Save payment' }).click();
  await expect(pay).toHaveCount(0);
  await expect(page.locator('tbody tr').filter({ hasText: `Cycle Supplier ${stamp}` }).first()).toContainText('Rs 57,000');

  // Ledger stays balanced and the exchange loss is posted
  const after = await (await page.request.get(`/api/workspace?tenant=${QA_TENANT}`)).json();
  for (const j of after.workspace.journals) {
    const debit = j.lines.reduce((n: number, l: { debit: string }) => n + Number(l.debit), 0);
    const credit = j.lines.reduce((n: number, l: { credit: string }) => n + Number(l.credit), 0);
    expect(Math.abs(debit - credit)).toBeLessThan(0.001);
  }
  const fxLines = after.workspace.journals.flatMap((j: { lines: { account: string; debit: string }[] }) => j.lines.filter(l => l.account === '5400'));
  expect(fxLines.some((l: { debit: string }) => Number(l.debit) === 1000)).toBe(true);
  expect(errors).toEqual([]);
});
