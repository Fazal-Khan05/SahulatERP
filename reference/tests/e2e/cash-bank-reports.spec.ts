import { expect, test, type Page } from '@playwright/test';
import { QA_TENANT } from '../../scripts/create-qa-tenant';

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
    const data = { type, payload, idempotencyKey: `cb-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
    let response = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data });
    if (response.status() >= 500) response = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data });
    return response;
  };
  if (await page.getByRole('heading', { name: 'Company', exact: true }).isVisible()) {
    await post('save_company', { name: 'QA Trading Company', address: '12 Jodia Bazar, Karachi' });
    await post('set_modules', { enabled: ['sales', 'purchasing', 'inventory', 'collections', 'cashbank', 'reports'] });
    await post('complete_setup', {});
  } else {
    const current = await (await page.request.get(`/api/workspace?tenant=${QA_TENANT}`)).json();
    await post('set_modules', { enabled: Array.from(new Set([...current.workspace.modules, 'sales', 'inventory', 'collections', 'cashbank', 'reports'])) });
  }
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  return post;
}
const openModule = (page: Page, module: string) => page.locator('button.nav-item').filter({ hasText: module }).click();
const money = (n: number) => `Rs ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(n)}`;

test('cash & bank accounts, cheque register and reports', async ({ page }) => {
  test.setTimeout(300_000);
  if (!process.env.BOOTSTRAP_OWNER_PASSWORD) test.skip(true, 'Owner credentials are unavailable.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const post = await signIn(page);
  const stamp = Date.now().toString().slice(-6);

  // Data: a customer with an open invoice (via API), so receipts have something to settle.
  const customer = (await (await post('save_party', { name: `Bank Customer ${stamp}`, type: 'customer', city: 'Karachi', email: '', taxId: '', registered: false, creditLimit: '10000000', terms: 30, customerClass: 'Retailer' })).json()).recordId as string;
  const item = (await (await post('save_item', { sku: `BK-${stamp}`, name: `Bank Item ${stamp}`, category: 'General', hsCode: '', unit: 'pcs', price: '1000', cost: '600', weight: '1', volume: '1', reorderLevel: 0 })).json()).recordId as string;
  const ws = (await (await page.request.get(`/api/workspace?tenant=${QA_TENANT}`)).json()).workspace;
  const warehouseId = ws.warehouses[0].id as string;
  await post('bulk_stock_increase', { warehouseId, date: '2026-10-01', purpose: 'opening_stock', reason: 'QA', lines: [{ itemId: item, quantity: '10', cost: '600' }] });
  const inv = await (await post('create_document', { kind: 'sales_invoice', partyId: customer, warehouseId, date: '2026-10-01', dueDate: '2026-10-05', lines: [{ itemId: item, quantity: '10', price: '1000', taxRate: '0' }] })).json();
  expect((await post('submit_document', { id: inv.recordId })).status()).toBe(200);
  await page.reload();
  await page.waitForLoadState('networkidle');

  // Cash & bank: provisioned accounts exist; add a second cash account
  await openModule(page, 'Cash & bank');
  await expect(page.getByRole('cell', { name: 'Main bank account' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'New account' }).click();
  const acc = page.getByRole('dialog', { name: 'New bank or cash account' });
  await acc.getByLabel('Account name').fill(`Petty cash ${stamp}`);
  await acc.getByLabel('Type').selectOption('cash');
  await acc.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByText(`Petty cash ${stamp} saved.`)).toBeVisible();

  // Receipt of 4,000 cash into the new petty cash account
  await openModule(page, 'Collections');
  await page.getByRole('button', { name: 'Record receipt' }).first().click();
  const receipt = page.getByRole('dialog', { name: 'Record customer receipt' });
  await receipt.getByLabel('Customer').selectOption(customer);
  await receipt.getByLabel('Amount to allocate oldest first').fill('4000');
  await receipt.getByLabel('Payment method').selectOption('cash');
  await receipt.getByLabel('Into account').selectOption({ label: `Petty cash ${stamp}` });
  await receipt.getByRole('button', { name: 'Save receipt' }).click();
  await expect(receipt).toHaveCount(0);
  // Cheque of 6,000: record, deposit into Main bank account, clear
  await page.getByRole('button', { name: 'Record receipt' }).first().click();
  const chq = page.getByRole('dialog', { name: 'Record customer receipt' });
  await chq.getByLabel('Customer').selectOption(customer);
  await chq.getByLabel('Amount to allocate oldest first').fill('6000');
  await chq.getByLabel('Payment method').selectOption('cheque');
  await chq.getByLabel('Cheque number').fill(`CHQ-${stamp}`);
  await chq.getByRole('button', { name: 'Save receipt' }).click();
  await expect(chq).toHaveCount(0);
  const chequeRow = page.locator('tbody tr').filter({ hasText: `CHQ-${stamp}` }).first();
  await chequeRow.getByLabel(`Deposit account for CHQ-${stamp}`).selectOption({ label: 'Main bank account' });
  await chequeRow.getByRole('button', { name: `Deposit CHQ-${stamp}` }).click();
  await expect(page.getByText('Cheque deposited.')).toBeVisible();
  await page.locator('tbody tr').filter({ hasText: `CHQ-${stamp}` }).first().getByRole('button', { name: `Clear CHQ-${stamp}` }).click();
  await expect(page.getByText('Cheque cleared.')).toBeVisible();

  // Balances moved; transfer and expense
  await openModule(page, 'Cash & bank');
  const petty = page.locator('tbody tr').filter({ hasText: `Petty cash ${stamp}` }).first();
  await expect(petty).toContainText(money(4000));
  const mainBefore = Number((await page.locator('tbody tr').filter({ hasText: 'Main bank account' }).first().locator('td').nth(4).innerText()).replace(/[^\d.-]/g, ''));
  await page.getByRole('button', { name: 'Transfer' }).click();
  const transfer = page.getByRole('dialog', { name: 'Transfer between accounts' });
  await transfer.getByLabel('From account').selectOption('main-bank');
  await transfer.getByLabel('To account').selectOption(`petty-cash-${stamp}`);
  await transfer.getByLabel('Transfer amount').fill('1000');
  await transfer.getByRole('button', { name: 'Transfer' }).click();
  await expect(page.getByText(/Transferred 1000.00 from Main bank account/)).toBeVisible();
  await page.getByRole('button', { name: 'Record expense' }).click();
  const expense = page.getByRole('dialog', { name: 'Record an expense' });
  await expense.getByLabel('Paid from account').selectOption(`petty-cash-${stamp}`);
  await expense.getByLabel('Expense amount').fill('250');
  await expense.getByLabel('Expense memo').fill('Courier');
  await expense.getByRole('button', { name: 'Record expense' }).click();
  await expect(page.getByText('Expense of 250.00 recorded.')).toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: `Petty cash ${stamp}` }).first()).toContainText(money(4750));
  await expect(page.locator('tbody tr').filter({ hasText: 'Main bank account' }).first()).toContainText(money(mainBefore - 1000));
  await page.locator('tbody tr').filter({ hasText: `Petty cash ${stamp}` }).first().getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { name: `Activity · Petty cash ${stamp}` })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Expense · Courier' })).toBeVisible();

  // Reports
  await openModule(page, 'Reports');
  await page.getByRole('button', { name: 'Aged receivables' }).click();
  await expect(page.getByRole('heading', { name: 'Aged receivables' })).toBeVisible();
  await expect(page.locator('tfoot')).toContainText('Total');
  await page.getByRole('button', { name: 'Customer / supplier statement' }).click();
  await page.getByLabel('Statement party').selectOption(customer);
  await expect(page.getByRole('cell', { name: 'Closing balance' })).toBeVisible();
  await expect(page.locator('tfoot')).toContainText(money(0)); // 10,000 invoiced − 4,000 − 6,000
  await page.getByRole('button', { name: 'Profit & loss' }).click();
  await expect(page.getByRole('cell', { name: 'Net profit' })).toBeVisible();
  await page.getByRole('button', { name: 'Balance sheet' }).click();
  await expect(page.locator('tfoot')).toContainText(money(0));
  await page.getByRole('button', { name: 'Control reconciliation' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: 'Bank & cash accounts' })).toContainText('reconciled');
  await page.getByRole('button', { name: 'Trial balance' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = await (await (await download).createReadStream()).toArray().then(chunks => Buffer.concat(chunks as Buffer[]).toString('utf8'));
  expect(csv.split('\n')[0]).toBe('Code,Account,Debit,Credit');
  expect(csv).toContain('1001,Main bank account');
  expect(errors).toEqual([]);
});
