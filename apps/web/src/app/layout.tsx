import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AutoRefreshProvider } from "@/components/shell/auto-refresh-provider";
import { ServiceWorkerRegister } from "@/components/shell/service-worker-register";
import { ThemeProvider } from "@/components/shell/theme-provider";
import { BRAND } from "@/lib/brand/config";
import "./globals.css";

const OFFLINE_BOOTSTRAP = `(function(){var root=document.documentElement;var key="atodotren:offline";function apply(offline){if(offline){root.setAttribute("data-atodotren-offline","true");try{sessionStorage.setItem(key,"1");}catch{}}else{root.removeAttribute("data-atodotren-offline");try{sessionStorage.removeItem(key);}catch{}}}var remembered=false;try{remembered=sessionStorage.getItem(key)==="1";}catch{}apply(remembered||!navigator.onLine);window.addEventListener("offline",function(){apply(true);});window.addEventListener("online",function(){apply(false);});})();`;

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.descriptionEs,
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [{ media: "(prefers-color-scheme: light)", color: BRAND.themeColorLight }, { media: "(prefers-color-scheme: dark)", color: BRAND.themeColorDark }] };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="es" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: OFFLINE_BOOTSTRAP }} /></head><body><ThemeProvider><AutoRefreshProvider>{children}<ServiceWorkerRegister /></AutoRefreshProvider></ThemeProvider></body></html>;
}
