export const BUSINESS_TIME_ZONE = "Asia/Karachi";

// Calendar date in the company's time zone. toISOString() is UTC, which is the
// previous day in Pakistan between 00:00 and 05:00.
export function businessToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
