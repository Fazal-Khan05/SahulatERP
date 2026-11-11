import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { listActivity } from "@/modules/tenant/queries";
import { ROLE_LABELS, can } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "Activity — SahulatERP" };

const ACTION_LABELS: Record<string, string> = {
  "auth.sign_in": "Signed in",
  "auth.sign_out": "Signed out",
  "auth.password_set": "Set a new password",
  "tenant.create": "Created the company",
  "branch.create": "Added a branch",
  "member.invite": "Invited a member",
  "member.add": "Was added as a member",
  "settings.update": "Changed the product name or logo",
  "module.update": "Switched a module",
  "file.upload": "Added a file",
  "job.enqueue": "Queued background work",
};

function details(after: unknown): string {
  if (!after || typeof after !== "object") return "";
  return Object.entries(after as Record<string, unknown>)
    .filter(([, value]) => value !== null && typeof value !== "object")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

// The session and the rows are read at request time, behind the boundary, so moving between
// pages shows the frame at once and the content as soon as it is ready.
export default function ActivityPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Activity />
    </Suspense>
  );
}

async function Activity() {
  const session = await requireTenant();
  if (!can(session.role, "audit.read")) {
    return <p className="text-muted-foreground">Only an owner or an auditor can see the activity log.</p>;
  }

  const rows = await listActivity(session);
  return (
    <Card title="Activity">
      <p className="mb-2 text-sm text-muted-foreground">
        The latest {rows.length} entries in the audit log of {session.tenantName}. Entries are never changed or removed.
      </p>
      <div className="overflow-x-auto">
        <table aria-label="Activity" className="w-full text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">When</th>
              <th className="py-2 pr-4 font-medium">Who</th>
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 pr-4 font-medium">What</th>
              <th className="py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="py-2 pr-4 whitespace-nowrap">{formatDateTime(row.at)}</td>
                <td className="py-2 pr-4">{row.actorEmail ?? (row.actorUserId ? "Former member" : "System")}</td>
                <td className="py-2 pr-4">{row.actorRole ? ROLE_LABELS[row.actorRole] : "—"}</td>
                <td className="py-2 pr-4">{ACTION_LABELS[row.action] ?? row.action}</td>
                <td className="py-2 text-muted-foreground">{details(row.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
