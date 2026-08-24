import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AutoRefreshProvider } from "@/components/shell/auto-refresh-provider";
import { ServiceWorkerRegister } from "@/components/shell/service-worker-register";
import { ThemeProvider } from "@/components/shell/theme-provider";
import { BRAND } from "@/lib/brand/config";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.descriptionEs,
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [{ media: "(prefers-color-scheme: light)", color: BRAND.themeColorLight }, { media: "(prefers-color-scheme: dark)", color: BRAND.themeColorDark }] };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="es" suppressHydrationWarning><body><ThemeProvider><AutoRefreshProvider>{children}<ServiceWorkerRegister /></AutoRefreshProvider></ThemeProvider></body></html>;
}
