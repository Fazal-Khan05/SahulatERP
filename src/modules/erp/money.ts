import Decimal from "decimal.js";
Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });
export const D = Object.assign((value: Decimal.Value = 0) => new Decimal(value), {
  min: Decimal.min.bind(Decimal) as typeof Decimal.min,
  max: Decimal.max.bind(Decimal) as typeof Decimal.max,
});
export const money = (value: Decimal.Value) => D(value).toFixed(4);
/** A quantity for display: thousands separators, every stored decimal kept ("1,234,567", "0.5", "1,500.125"). */
export function formatQuantity(value: Decimal.Value) {
  const [whole, fraction]=D(value).toFixed().split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g,",")}${fraction?`.${fraction}`:""}`;
}
export const sum =(values: Decimal.Value[]) => values.reduce<Decimal>((a,b)=>a.plus(b),D(0));
export function allocate(total: string, weights: string[]) {
  if (!weights.length || weights.some(w=>D(w).lt(0)) || sum(weights).lte(0)) throw new Error("Allocation needs positive weights.");
  const denominator=sum(weights); let remaining=D(total);
  return weights.map((w,i)=>{const amount=i===weights.length-1?remaining:D(total).mul(w).div(denominator).toDecimalPlaces(4); remaining=remaining.minus(amount);return money(amount);});
}
/**
 * Display money. PKR, or no currency, keeps the app's "Rs 1,234.5" style (and `formatMoney(value, true)` its compact chart
 * form); any other currency prints its own symbol with two decimals: "$10.00", "¥10.00".
 */
// Building an Intl.NumberFormat is far slower than using one; large tables format thousands of amounts per render.
const formatters = new Map<string, Intl.NumberFormat>();
const formatter = (key: string, make: () => Intl.NumberFormat) => { let f = formatters.get(key); if (!f) { f = make(); formatters.set(key, f); } return f; };
export function formatMoney(value: string | number, compact?: boolean): string;
export function formatMoney(value: string | number, currency?: string, compact?: boolean): string;
export function formatMoney(value: string | number, currencyOrCompact?: string | boolean, compactFlag=false) {
  const currency=typeof currencyOrCompact==="string"&&currencyOrCompact?currencyOrCompact:"PKR";
  const compact=typeof currencyOrCompact==="boolean"?currencyOrCompact:compactFlag;
  const n=Number(value);
  if(currency!=="PKR")return formatter(`${currency}|${compact}`,()=>new Intl.NumberFormat("en-US",{style:"currency",currency,currencyDisplay:"narrowSymbol",notation:compact?"compact":"standard"})).format(n);
  if(compact && Math.abs(n)>=1e6)return `Rs ${(n/1e6).toFixed(2)}m`;
  if(compact && Math.abs(n)>=1e3)return `Rs ${(n/1e3).toFixed(1)}k`;
  return `Rs ${formatter("PKR",()=>new Intl.NumberFormat("en-PK",{maximumFractionDigits:2})).format(n)}`;
}
