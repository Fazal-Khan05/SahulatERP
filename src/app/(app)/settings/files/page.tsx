import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { listFiles } from "@/modules/files/queries";
import { FILE_MAX_BYTES, FILE_TYPES, formatBytes } from "@/modules/files/rules";
import { can } from "@/modules/tenant/rules";
import { uploadFileAction } from "../actions";

export const metadata: Metadata = { title: "Files" };

const TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/webp": "WebP image",
};

export default function FilesPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Files />
    </Suspense>
  );
}

async function Files() {
  const session = await requireTenant();
  if (!can(session.role, "file.read")) {
    return <p className="text-muted-foreground">Only an owner or an auditor can see the files.</p>;
  }
  const files = await listFiles(session);

  return (
    <div className="flex flex-col gap-5">
      <Card title="Files">
        <p className="mb-2 text-sm text-muted-foreground">
          Scans and documents kept for {session.tenantName}. A download link works for one minute and only for the
          person who asked for it.
        </p>
        {files.length === 0 ? (
          <Empty>No files yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Files" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Size</th>
                  <th className="py-2 pr-4 font-medium">Added</th>
                  <th className="py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {files.map((file) => (
                  <tr key={file.id}>
                    <td className="py-2 pr-4">
                      {/* A plain link, not a client-side navigation: it answers with a redirect to the file. */}
                      <a href={`/files/${file.id}`} className="font-semibold text-primary hover:underline">
                        {file.name}
                      </a>
                    </td>
                    <td className="py-2 pr-4">{TYPE_LABELS[file.contentType] ?? file.contentType}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatBytes(file.sizeBytes)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{file.storedAt ? formatDateTime(file.storedAt) : ""}</td>
                    <td className="py-2">{file.addedBy ?? "Former member"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {can(session.role, "file.upload") ? (
        <Card title="Add a file" className="max-w-xl">
          <ActionForm action={uploadFileAction} submitLabel="Add file" maxUploadBytes={FILE_MAX_BYTES}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="file">File</Label>
              <input
                id="file"
                name="file"
                type="file"
                required
                accept={FILE_TYPES.join(",")}
                className="text-sm file:mr-3 file:rounded-lg file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-semibold"
              />
              <p className="text-xs text-muted-foreground">PDF, PNG, JPEG or WebP, 4 MB or smaller.</p>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
