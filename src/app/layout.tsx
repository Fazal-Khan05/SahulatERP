import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { EmailLinkCatcher } from "@/components/email-link-catcher";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SahulatERP",
  description: "Accounts, stock and sales for trading and distribution companies.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <EmailLinkCatcher />
        {children}
      </body>
    </html>
  );
}
