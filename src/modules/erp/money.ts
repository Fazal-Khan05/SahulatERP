import Decimal from "decimal.js";
Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });
export const D = Object.assign((value: Decimal.Value = 0) => new Decimal(value), {
  min: Decimal.min.bind(Decimal) as typeof Decimal.min,
  max: Decimal.max.bind(Decimal) as typeof Decimal.max,
});
export const money = (value: Decimal.Value) => D(value).toFixed(4);
export const sum = (values: Decimal.Value[]) => values.reduce<Decimal>((a,b)=>a.plus(b),D(0));
export function allocate(total: string, weights: string[]) {
  if (!weights.length || weights.some(w=>D(w).lt(0)) || sum(weights).lte(0)) throw new Error("Allocation needs positive weights.");
  const denominator=sum(weights); let remaining=D(total);
  return weights.map((w,i)=>{const amount=i===weights.length-1?remaining:D(total).mul(w).div(denominator).toDecimalPlaces(4); remaining=remaining.minus(amount);return money(amount);});
}
export function formatMoney(value: string | number, compact=false) {
  const n=Number(value);
  if(compact && Math.abs(n)>=1e6)return `Rs ${(n/1e6).toFixed(2)}m`;
  if(compact && Math.abs(n)>=1e3)return `Rs ${(n/1e3).toFixed(1)}k`;
  return `Rs ${new Intl.NumberFormat("en-PK",{maximumFractionDigits:2}).format(n)}`;
}
