import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { ACTION_LABELS } from "@/modules/tenant/activity-labels";
import { listSignIns } from "@/modules/tenant/queries";
import { ROLE_LABELS, can } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "Sign-ins — SahulatERP" };

const METHODS: Record<string, string> = {
  password: "Password",
  invite: "Invitation link",
  recovery: "Password reset link",
};

function field(after: unknown, key: string): string | null {
  if (!after || typeof after !== "object") return null;
  const value = (after as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

export default function SignInsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SignIns />
    </Suspense>
  );
}

async function SignIns() {
  const session = await requireTenant();
  if (!can(session.role, "audit.read")) {
    return <p className="text-muted-foreground">Only an owner or an auditor can see the sign-in history.</p>;
  }

  const rows = await listSignIns(session);
  return (
    <Card title="Sign-ins">
      <p className="mb-2 text-sm text-muted-foreground">
        The latest {rows.length} sign-ins, sign-outs, password and two-step changes by members of {session.tenantName}.
        The device and address are what the browser and the network said; a sign-in you do not recognise is a reason to
        change that member&apos;s password.
      </p>
      <div className="overflow-x-auto">
        <table aria-label="Sign-ins" className="w-full text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">When</th>
              <th className="py-2 pr-4 font-medium">Who</th>
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 pr-4 font-medium">What</th>
              <th className="py-2 pr-4 font-medium">How</th>
              <th className="py-2 pr-4 font-medium">Device</th>
              <th className="py-2 font-medium">Address</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => {
              const method = field(row.after, "method");
              return (
                <tr key={row.id}>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatDateTime(row.at)}</td>
                  <td className="py-2 pr-4">{row.actorEmail ?? (row.actorUserId ? "Former member" : "System")}</td>
                  <td className="py-2 pr-4">{row.actorRole ? ROLE_LABELS[row.actorRole] : "—"}</td>
                  <td className="py-2 pr-4">{ACTION_LABELS[row.action] ?? row.action}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{method ? (METHODS[method] ?? method) : "—"}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{field(row.after, "device") ?? "—"}</td>
                  <td className="py-2 font-mono text-xs text-muted-foreground">{field(row.after, "address") ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
