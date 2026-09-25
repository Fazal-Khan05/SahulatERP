import { boolean, date, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { Workspace } from '@/modules/erp/types';

export const appRole = pgEnum('app_role', ['Owner','Accountant','Sales Manager','Salesperson','Recovery Officer','Warehouse Manager','Payroll Administrator','Auditor']);
export const tenants = pgTable('tenants', {
  id: uuid().primaryKey(), name: text().notNull(), isDemo: boolean('is_demo').notNull().default(false),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(), updatedAt: timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
});
export const memberships = pgTable('memberships', {
  tenantId: uuid('tenant_id').notNull().references(()=>tenants.id,{onDelete:'cascade'}), userId: uuid('user_id').notNull(), role: appRole().notNull(),
  branchIds: text('branch_ids').array().notNull().default([]), active: boolean().notNull().default(true), createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
}, table=>[primaryKey({columns:[table.tenantId,table.userId]})]);
export const workspaceSnapshots = pgTable('workspace_snapshots', {
  tenantId: uuid('tenant_id').primaryKey().references(()=>tenants.id,{onDelete:'cascade'}), revision: integer().notNull().default(0),
  schemaVersion: integer('schema_version').notNull().default(1), data: jsonb().$type<Workspace>().notNull(), updatedAt: timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
});
export const documents = pgTable('documents', {
  tenantId: uuid('tenant_id').notNull().references(()=>tenants.id,{onDelete:'cascade'}), id: text().notNull(), number: text().notNull(), kind: text().notNull(), status: text().notNull(),
  partyId: text('party_id').notNull(), warehouseId: text('warehouse_id').notNull(), documentDate: date('document_date').notNull(), currency: text().notNull(),
  total: numeric({precision:20,scale:4}).notNull(), paid: numeric({precision:20,scale:4}).notNull().default('0'), returned: numeric({precision:20,scale:4}).notNull().default('0'), data: jsonb().notNull(),
}, table=>[primaryKey({columns:[table.tenantId,table.id]}),unique().on(table.tenantId,table.number)]);
export const journals = pgTable('journals', {
  tenantId: uuid('tenant_id').notNull().references(()=>tenants.id,{onDelete:'cascade'}), id: text().notNull(), number: text().notNull(), sourceId: text('source_id').notNull(),
  journalDate: date('journal_date').notNull(), memo: text().notNull(), status: text().notNull(), reversalOf: text('reversal_of'), data: jsonb().notNull(),
}, table=>[primaryKey({columns:[table.tenantId,table.id]}),unique().on(table.tenantId,table.sourceId)]);
export const journalLines = pgTable('journal_lines', {
  tenantId: uuid('tenant_id').notNull(), journalId: text('journal_id').notNull(), lineNo: integer('line_no').notNull(), accountCode: text('account_code').notNull(),
  debit: numeric({precision:20,scale:4}).notNull().default('0'), credit: numeric({precision:20,scale:4}).notNull().default('0'),
}, table=>[primaryKey({columns:[table.tenantId,table.journalId,table.lineNo]})]);
