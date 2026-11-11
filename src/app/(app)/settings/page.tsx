import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { can } from "@/modules/tenant/rules";
import { updateBrandingAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };

export default function GeneralSettingsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <General />
    </Suspense>
  );
}

async function General() {
  const session = await requireTenant();
  if (!can(session.role, "settings.read")) {
    return <p className="text-muted-foreground">Only an owner or an auditor can open these settings.</p>;
  }
  const { productName, logoUrl } = session.branding;
  const logo = logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- served per session by /branding/logo, not a static asset
    <img
      src={logoUrl}
      alt="Current logo"
      className="h-16 w-auto max-w-48 rounded-md border bg-card object-contain p-1"
    />
  ) : (
    <p className="text-sm text-muted-foreground">No logo yet.</p>
  );

  return (
    <Card title="Product name and logo" className="max-w-xl">
      <p className="mb-4 text-sm text-muted-foreground">
        The name appears at the top of every screen, and the logo at the top of every screen and every printed
        document, for everyone in {session.tenantName}.
      </p>
      {can(session.role, "branding.update") ? (
        <ActionForm action={updateBrandingAction} submitLabel="Save">
          <Field
            // Remount with the saved value after a save, so the field never shows a stale name.
            key={productName}
            label="Product name"
            name="productName"
            defaultValue={productName}
            required
            maxLength={60}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="logo">Logo</Label>
            {logo}
            <input
              id="logo"
              name="logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="text-sm file:mr-3 file:rounded-lg file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-semibold"
            />
            <p className="text-xs text-muted-foreground">PNG, JPEG or WebP, 256 KB or smaller.</p>
            {logoUrl ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="removeLogo" />
                Remove the logo
              </label>
            ) : null}
          </div>
        </ActionForm>
      ) : (
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Product name</dt>
            <dd className="font-medium">{productName}</dd>
          </div>
          <div>
            <dt className="mb-1 text-muted-foreground">Logo</dt>
            <dd>{logo}</dd>
          </div>
        </dl>
      )}
      <p className="mt-5 border-t pt-4 text-sm">
        <Link href="/print/letterhead" className="font-semibold text-primary hover:underline">
          See how printed documents will start
        </Link>
      </p>
    </Card>
  );
}
