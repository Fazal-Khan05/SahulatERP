import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listFiscalPeriods, listNumberSeries } from "@/modules/numbering/queries";
import { DOCUMENT_TYPES, MONTHS, fiscalYearLabel, formatDocumentNumber, isDocumentType, nextDay, periodName } from "@/modules/numbering/rules";
import { can } from "@/modules/tenant/rules";
import { openFiscalYearAction, setPeriodLockedAction } from "../actions";

export const metadata: Metadata = { title: "Fiscal periods" };

export default function PeriodsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Periods />
    </Suspense>
  );
}

async function Periods() {
  const session = await requireTenant();
  if (!can(session.role, "period.read")) {
    return <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the fiscal periods.</p>;
  }
  const today = todayIso(new Date());
  const [periods, series] = await Promise.all([listFiscalPeriods(session), listNumberSeries(session)]);
  const manager = can(session.role, "period.manage");
  const years = [...new Set(periods.map((period) => period.yearStart))];
  const last = periods.at(-1);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Card title="Fiscal periods">
        <p className="mb-2 text-sm text-muted-foreground">
          A document can be written only into a month that is open here and not locked. Lock a month once its books are closed;
          an owner can unlock it again.
        </p>
        {periods.length === 0 ? (
          <Empty>No fiscal year is open yet.</Empty>
        ) : (
          years.map((yearStart) => (
            <div key={yearStart} className="mt-4 overflow-x-auto first:mt-0">
              <table aria-label={`Fiscal year ${fiscalYearLabel(yearStart)}`} className="w-full text-left text-sm">
                <caption className="pb-1 text-left text-sm font-bold">Fiscal year {fiscalYearLabel(yearStart)}</caption>
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Month</th>
                    <th className="py-2 pr-4 font-medium">From</th>
                    <th className="py-2 pr-4 font-medium">To</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {periods
                    .filter((period) => period.yearStart === yearStart)
                    .map((period) => {
                      const locked = period.lockedAt !== null;
                      return (
                        <tr key={period.id}>
                          <td className="py-2 pr-4 font-medium whitespace-nowrap">
                            {periodName(period.startsOn)}
                            {period.startsOn <= today && today <= period.endsOn ? <span className="text-muted-foreground"> · this month</span> : null}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(period.startsOn)}</td>
                          <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(period.endsOn)}</td>
                          <td className="py-2 pr-4">
                            <span className={locked ? "rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground" : "rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground"}>
                              {locked ? "Locked" : "Open"}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            {manager ? (
                              <ActionForm
                                action={setPeriodLockedAction.bind(null, period.id, !locked)}
                                submitLabel={`${locked ? "Unlock" : "Lock"} ${periodName(period.startsOn)}`}
                                compact
                              />
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ))
        )}
      </Card>

      {manager ? (
        <Card title={last ? "Open the next fiscal year" : "Open the first fiscal year"}>
          {last ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                The next year starts on {formatIsoDate(nextDay(last.endsOn))} and adds twelve months after the last one above.
              </p>
              <ActionForm action={openFiscalYearAction} submitLabel="Open next fiscal year" compact />
            </>
          ) : (
            <ActionForm action={openFiscalYearAction} submitLabel="Open fiscal year">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="month">Starts in</Label>
                <select id="month" name="month" defaultValue="7" className="h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm">
                  {MONTHS.map((month, index) => (
                    <option key={month} value={index + 1}>
                      {month}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">July is the usual start in Pakistan. It cannot be changed once the year is open.</p>
              </div>
              <Field label="Year" name="year" defaultValue={Number(today.slice(5, 7)) >= 7 ? today.slice(0, 4) : String(Number(today.slice(0, 4)) - 1)} required inputMode="numeric" maxLength={4} hint="The calendar year the fiscal year starts in." />
            </ActionForm>
          )}
        </Card>
      ) : null}

      <Card title="Document numbers">
        <p className="mb-2 text-sm text-muted-foreground">
          Each kind of document is numbered in order within a fiscal year, and a number is never used twice. This shows the number the
          next one will get.
        </p>
        {series.length === 0 ? (
          <Empty>No document has been numbered yet.</Empty>
        ) : (
          <table aria-label="Document numbers" className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Document</th>
                <th className="py-2 pr-4 font-medium">Fiscal year</th>
                <th className="py-2 font-medium">Next number</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {series.map((row) => (
                <tr key={`${row.documentType}-${row.yearStart}`}>
                  <td className="py-2 pr-4">{isDocumentType(row.documentType) ? DOCUMENT_TYPES[row.documentType] : row.documentType}</td>
                  <td className="py-2 pr-4">{fiscalYearLabel(row.yearStart)}</td>
                  <td className="py-2 font-medium">{isDocumentType(row.documentType) ? formatDocumentNumber(row.documentType, row.yearCode, row.nextNumber) : row.nextNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
