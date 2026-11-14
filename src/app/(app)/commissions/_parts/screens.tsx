import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant, type TenantSession } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { getPlan, listPlans, listRateChoices, listTeam, type Plan, type TeamMember } from "@/modules/commissions/queries";
import { PLAN_KIND_LABELS } from "@/modules/commissions/rules";
import { formatIsoDate } from "@/modules/currencies/rules";
import { ROLE_LABELS, can, type MemberRole } from "@/modules/tenant/rules";
import { deletePlanAction, savePlanAction, setManagerAction } from "./actions";
import { PlanFields, type PlanInitial } from "./plan-fields";

const SELECT = "h-8 min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

function refusal(session: TenantSession): string | null {
  if (!session.modules.commissions) return "Commissions is switched off for this company.";
  return can(session.role, "commission.read") ? null : "Your role does not include commission plans.";
}

const percent = (value: Plan["rate"]) => `${value.toFixed()}%`;

/** A plan in words: how it pays, and its target and team rate when it has them. */
function describe(plan: Plan): string[] {
  const lines: string[] = [];
  if (plan.kind === "flat") lines.push(`${percent(plan.rate)} of sales before tax`);
  if (plan.kind === "per_unit") lines.push(`Rs ${formatAmount(plan.rate)} for each unit sold`);
  if (plan.kind === "category") lines.push(`${plan.categoryRates.map((r) => `${r.categoryName} ${percent(r.rate)}`).join(", ") || "No category rates"}; anything else ${percent(plan.rate)}`);
  if (plan.kind === "customer_class") lines.push(`${plan.classRates.map((r) => `${r.customerClass} ${percent(r.rate)}`).join(", ") || "No class rates"}; anything else ${percent(plan.rate)}`);
  if (plan.kind === "tiered") lines.push(plan.tiers.map((t) => `from ${formatAmount(t.threshold)}: ${percent(t.rate)}`).join(", "));
  if (plan.target.gt(0)) lines.push(`Target ${formatAmount(plan.target)} a month, then ×${plan.multiplier.toFixed()}`);
  if (plan.teamRate.gt(0)) lines.push(`As a manager: ${percent(plan.teamRate)} of the team's sales`);
  return lines;
}

export async function CommissionsScreen() {
  const session = await requireTenant();
  const refused = refusal(session);
  if (refused) {
    return (
      <>
        <PageHead title="Commission plans" />
        <p className="text-muted-foreground">{refused}</p>
      </>
    );
  }
  const owner = can(session.role, "commission.manage");
  const [plans, team] = await Promise.all([listPlans(session), listTeam(session)]);
  const nameOf = (userId: string | null) => (userId === null ? "Everyone else (default)" : (team.find((m) => m.userId === userId)?.email ?? "A former member"));
  const today = todayIso(new Date());
  return (
    <>
      <PageHead title="Commission plans" sub="Who earns what on their sales, and who reports to whom. Commission itself is worked out when invoices are posted." />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card title="Plans">
          {owner ? (
            <Link href="/commissions/plans/new" className={buttonVariants({ className: "mb-4" })}>
              New plan
            </Link>
          ) : null}
          {plans.length === 0 ? (
            <Empty>No plan yet. Until there is one, no commission is earned.</Empty>
          ) : (
            <ul aria-label="Plans" className="divide-y text-sm">
              {plans.map((plan) => {
                const current = plan.from <= today && (plan.to === null || plan.to >= today);
                return (
                  <li key={plan.id} className="flex flex-col gap-0.5 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      {owner ? (
                        <Link href={`/commissions/plans/${plan.id}`} className="font-semibold underline-offset-4 hover:underline">
                          {plan.name}
                        </Link>
                      ) : (
                        <span className="font-semibold">{plan.name}</span>
                      )}
                      <span className="text-muted-foreground">{nameOf(plan.userId)}</span>
                      <span className="text-muted-foreground">
                        {formatIsoDate(plan.from)} to {plan.to ? formatIsoDate(plan.to) : "no end"}
                      </span>
                      {current ? <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">In use</span> : null}
                    </div>
                    <span>{PLAN_KIND_LABELS[plan.kind]}</span>
                    {describe(plan).map((line) => (
                      <span key={line} className="text-muted-foreground">
                        {line}
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Who reports to whom">
          {team.length === 0 ? (
            <Empty>The sales team has nobody in it yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Sales team" className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Member</th>
                    <th className="py-2 pr-4 font-medium">Role</th>
                    <th className="py-2 font-medium">Reports to</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {team.map((member) => (
                    <tr key={member.userId}>
                      <td className="py-2 pr-4">{member.email}</td>
                      <td className="py-2 pr-4">{ROLE_LABELS[member.role as MemberRole] ?? member.role}</td>
                      <td className="py-2">{owner ? <ManagerForm member={member} team={team} /> : (team.find((m) => m.userId === member.managerUserId)?.email ?? "Nobody")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function ManagerForm({ member, team }: { member: TeamMember; team: TeamMember[] }) {
  return (
    <ActionForm action={setManagerAction.bind(null, member.userId)} submitLabel="Save" compact>
      <select name="managerUserId" defaultValue={member.managerUserId ?? ""} aria-label={`Who ${member.email} reports to`} className={SELECT}>
        <option value="">Nobody</option>
        {team
          .filter((other) => other.userId !== member.userId)
          .map((other) => (
            <option key={other.userId} value={other.userId}>
              {other.email}
            </option>
          ))}
      </select>
    </ActionForm>
  );
}

export async function PlanScreen({ id }: { id: string | null }) {
  const session = await requireTenant();
  const refused = refusal(session) ?? (can(session.role, "commission.manage") ? null : "Only the owner can set up commission plans.");
  const title = id === null ? "New commission plan" : "Commission plan";
  if (refused) {
    return (
      <>
        <PageHead title={title} />
        <p className="text-muted-foreground">{refused}</p>
      </>
    );
  }
  const [plan, team, choices] = await Promise.all([id === null ? null : getPlan(session, id), listTeam(session), listRateChoices(session)]);
  if (id !== null && !plan) notFound();
  const initial: PlanInitial = plan
    ? {
        name: plan.name,
        userId: plan.userId ?? "",
        kind: plan.kind,
        rate: plan.rate.toFixed(),
        target: plan.target.toFixed(),
        multiplier: plan.multiplier.toFixed(),
        teamRate: plan.teamRate.toFixed(),
        from: plan.from,
        to: plan.to ?? "",
        categoryRates: plan.categoryRates.map((r) => ({ categoryId: r.categoryId, rate: r.rate.toFixed() })),
        classRates: plan.classRates.map((r) => ({ customerClass: r.customerClass, rate: r.rate.toFixed() })),
        tiers: plan.tiers.map((t) => ({ threshold: t.threshold.toFixed(), rate: t.rate.toFixed() })),
      }
    : { name: "", userId: "", kind: "flat", rate: "", target: "0", multiplier: "1", teamRate: "0", from: todayIso(new Date()), to: "", categoryRates: [], classRates: [], tiers: [] };
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/commissions" className="text-muted-foreground underline-offset-4 hover:underline">
          Commission plans
        </Link>
      </p>
      <PageHead title={plan ? plan.name : title} sub="A plan for one person, or the default plan for everyone without one. A person's plans may not overlap in time." />
      <div className="flex max-w-3xl flex-col gap-5">
        <Card>
          <ActionForm action={savePlanAction.bind(null, id)} submitLabel="Save plan">
            <PlanFields initial={initial} people={team.map((m) => ({ userId: m.userId, label: m.email }))} categories={choices.categories} classes={choices.classes} />
          </ActionForm>
        </Card>
        {plan ? (
          <Card title="Remove this plan">
            <p className="mb-3 text-sm text-muted-foreground">For a plan set up by mistake. A plan that has been in use is ended with a date instead.</p>
            <ActionForm action={deletePlanAction.bind(null, plan.id)} submitLabel="Remove plan" compact />
          </Card>
        ) : null}
      </div>
    </>
  );
}
