import type { Metadata } from "next";
import { Archivo, Inter } from "next/font/google";
import { Suspense } from "react";
import { Toaster } from "sonner";

import { QueryFlashMessages } from "@/components/query-flash-messages";

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
  title: "Tennis Club",
  description: "Manage your tennis club account.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${archivo.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster
          position="bottom-right"
          closeButton
          richColors
          gap={8}
          offset={16}
          mobileOffset={12}
          toastOptions={{
            classNames: {
              toast:
                "!w-[calc(100vw-1.5rem)] sm:!w-auto sm:!max-w-sm !rounded-xl !border !px-3 !py-2 !text-sm !shadow-[0_6px_16px_var(--shadow-neutral)]",
              title: "!text-sm !font-medium !leading-5",
              content: "!gap-0",
              icon: "!h-4 !w-4",
              closeButton:
                "!static !ml-1 !h-6 !w-6 !translate-y-0 !rounded-md !border-0 !bg-transparent !p-1 !text-[var(--toast-close-text)] hover:!bg-[var(--toast-close-hover-background)] hover:!text-[var(--toast-close-hover-text)]",
            },
          }}
        />
        <Suspense fallback={null}>
          <QueryFlashMessages />
        </Suspense>
      </body>
    </html>
  );
}
