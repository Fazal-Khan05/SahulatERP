import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { MODULES, MODULE_INFO, can } from "@/modules/tenant/rules";
import { setModuleAction } from "../actions";

export const metadata: Metadata = { title: "Modules" };

export default function ModulesPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Modules />
    </Suspense>
  );
}

async function Modules() {
  const session = await requireTenant();
  if (!can(session.role, "settings.read")) {
    return <p className="text-muted-foreground">Only an owner or an auditor can open these settings.</p>;
  }
  const canSwitch = can(session.role, "module.update");

  return (
    <Card title="Modules">
      <p className="mb-2 text-sm text-muted-foreground">
        A module that is off disappears for everyone in {session.tenantName}: no menu entry, no column, no report
        section. Nothing already entered is deleted.
      </p>
      <table aria-label="Modules" className="w-full text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Module</th>
            <th className="py-2 pr-4 font-medium max-sm:hidden">Needs</th>
            <th className="py-2 pr-4 font-medium">State</th>
            {canSwitch ? <th className="py-2 font-medium" /> : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {MODULES.map((key) => {
            const info = MODULE_INFO[key];
            const on = session.modules[key];
            return (
              <tr key={key} data-module={key} className="align-top">
                <td className="py-2.5 pr-4">
                  <span className="font-medium">{info.label}</span>
                  <span className="block text-muted-foreground">{info.about}</span>
                </td>
                <td className="py-2.5 pr-4 text-muted-foreground max-sm:hidden">
                  {info.requires.map((needed) => MODULE_INFO[needed].label).join(", ") || "—"}
                </td>
                <td className="py-2.5 pr-4">
                  <span
                    className={
                      on
                        ? "rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground"
                        : "rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
                    }
                  >
                    {on ? "On" : "Off"}
                  </span>
                </td>
                {canSwitch ? (
                  <td className="py-2 sm:w-64">
                    <ActionForm action={setModuleAction} submitLabel={on ? "Turn off" : "Turn on"} compact>
                      <input type="hidden" name="module" value={key} />
                      <input type="hidden" name="enabled" value={on ? "false" : "true"} />
                    </ActionForm>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
