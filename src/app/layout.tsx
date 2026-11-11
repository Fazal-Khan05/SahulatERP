import type { Metadata } from "next";
import { EmailLinkCatcher } from "@/components/email-link-catcher";
import { DEFAULT_PRODUCT_NAME } from "@/modules/tenant/rules";
import "./globals.css";

export const metadata: Metadata = {
  title: DEFAULT_PRODUCT_NAME,
  description: "Accounts, stock and sales for trading and distribution companies.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" dir="ltr" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <EmailLinkCatcher />
        {children}
      </body>
    </html>
  );
}
