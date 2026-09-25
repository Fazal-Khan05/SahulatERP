import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata={title:"SahulatERP · Your business, connected",description:"The working ERP for Pakistani importers and distributors.",icons:{icon:"/favicon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
