import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./tokens.css";
import "./globals.css";
import "./print/print.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = { title: "SahulatERP · Your business, connected", description: "The working ERP for Pakistani importers and distributors.", icons: { icon: "/favicon.svg" } };
// Light-only product today: theme-color matches the top bar; keyboard resizes the layout viewport on Android.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content", colorScheme: "light", themeColor: "#f7f6f3" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={`${sans.variable} ${mono.variable}`}><body>{children}</body></html>;
}
