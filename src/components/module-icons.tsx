import { Boxes, CircleDollarSign, ClipboardList, FileText, HandCoins, Landmark, LayoutDashboard, Settings, Ship, ShoppingBag, Users, Wallet } from 'lucide-react';
import type { Module } from '@/modules/erp/types';

/** One icon per module, shared by the sidebar, the feature picker and Settings so a module looks the same everywhere. */
export const moduleIcons: Record<Module, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  sales: ShoppingBag,
  purchasing: ClipboardList,
  imports: Ship,
  inventory: Boxes,
  collections: Wallet,
  cashbank: Landmark,
  commissions: HandCoins,
  payroll: Users,
  accounting: CircleDollarSign,
  reports: FileText,
  settings: Settings,
};

/** Short benefit line for the feature picker tiles; the catalogue keeps the fuller description. */
export const moduleBenefits: Partial<Record<Module, string>> = {
  sales: 'Quote, invoice and get paid',
  purchasing: 'Order and receive from suppliers',
  inventory: 'Know what is in stock',
  imports: 'True landed cost per unit',
  collections: 'Track cheques and recovery',
  cashbank: 'Every rupee in and out',
  commissions: 'Pay on cash, not on paper',
  payroll: 'Monthly salaries, done',
  reports: 'The numbers your accountant needs',
};
