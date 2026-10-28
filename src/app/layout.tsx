import type { Metadata } from "next";
import { Archivo, Inter } from "next/font/google";
import { Suspense } from "react";
import { AppToaster } from "@/components/app-toaster";

import { DesktopNavbar } from "@/components/desktop-navbar";
import { MobileNavbar, MobileNavbarFallback } from "@/components/mobile-navbar";
import { MobileNavbarShell } from "@/components/mobile-navbar-menu";
import { QueryFlashMessages } from "@/components/query-flash-messages";
import { ProfileDepartureProvider } from "@/components/profile-departure-navigation";
import { SiteFooter } from "@/components/site-footer";
import { getApplicationUrl } from "@/lib/auth/site-url";

import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  // Canonical and sitemap URLs resolve against the configured public origin.
  ...(process.env.APP_URL && { metadataBase: new URL(getApplicationUrl("/")) }),
  title: "Tennis Club",
  description: "Book a court, find coaching and visit the club’s locations.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${archivo.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ProfileDepartureProvider>
          <MobileNavbarShell>
            <Suspense fallback={<MobileNavbarFallback />}>
              <MobileNavbar />
            </Suspense>
          </MobileNavbarShell>
          <DesktopNavbar />

          {children}
          <SiteFooter />
        </ProfileDepartureProvider>

        <AppToaster />

        <Suspense fallback={null}>
          <QueryFlashMessages />
        </Suspense>
      </body>
    </html>
  );
}
