import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { AutoRefreshProvider } from "@/components/shell/auto-refresh-provider";
import { ServiceWorkerRegister } from "@/components/shell/service-worker-register";
import { ThemeProvider } from "@/components/shell/theme-provider";
import { BRAND } from "@/lib/brand/config";
import { isLang, LANGUAGES } from "@/lib/i18n";
import "../globals.css";

const OFFLINE_BOOTSTRAP = `(function(){var root=document.documentElement;var key="atodotren:offline";function apply(offline){if(offline){root.setAttribute("data-atodotren-offline","true");try{sessionStorage.setItem(key,"1");}catch{}}else{root.removeAttribute("data-atodotren-offline");try{sessionStorage.removeItem(key);}catch{}}}async function verifyOnline(){try{var response=await fetch("/manifest.webmanifest?atodotren-connectivity="+Date.now(),{cache:"no-store",credentials:"same-origin"});if(response.ok)apply(false);}catch{}}var remembered=false;try{remembered=sessionStorage.getItem(key)==="1";}catch{}if(remembered){apply(true);if(navigator.onLine)void verifyOnline();}else{apply(!navigator.onLine);}window.addEventListener("offline",function(){apply(true);});window.addEventListener("online",function(){void verifyOnline();});})();`;

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.descriptionEs,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [{ media: "(prefers-color-scheme: light)", color: BRAND.themeColorLight }, { media: "(prefers-color-scheme: dark)", color: BRAND.themeColorDark }] };

export function generateStaticParams() { return LANGUAGES.map((lang) => ({ lang })); }

export default async function LangLayout({ children, params }: { readonly children: ReactNode; readonly params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return <html lang={lang} suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: OFFLINE_BOOTSTRAP }} /></head><body><ThemeProvider><AutoRefreshProvider><AppShell lang={lang}>{children}</AppShell><ServiceWorkerRegister /></AutoRefreshProvider></ThemeProvider></body></html>;
}
