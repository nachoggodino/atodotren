import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { AutoRefreshProvider } from "@/components/shell/auto-refresh-provider";
import { ServiceWorkerRegister } from "@/components/shell/service-worker-register";
import { ThemeProvider } from "@/components/shell/theme-provider";
import { BRAND } from "@/lib/brand/config";
import { isLang, LANGUAGES } from "@/lib/i18n";
import { OFFLINE_BOOTSTRAP } from "@/lib/offline/bootstrap";
import { publicBaseUrl } from "@/lib/seo";
import "../globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: BRAND.themeColorLight },
    { media: "(prefers-color-scheme: dark)", color: BRAND.themeColorDark },
  ],
};

export function generateStaticParams() {
  return LANGUAGES.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const base = publicBaseUrl();
  return {
    title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
    description: lang === "en" ? BRAND.descriptionEn : BRAND.descriptionEs,
    manifest: "/manifest.webmanifest",
    icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }] },
    ...(base === null ? {} : { metadataBase: base }),
  };
}

export default async function LangLayout({ children, params }: { readonly children: ReactNode; readonly params: Promise<{ lang: string }> }) {
  const [{ lang }, requestHeaders] = await Promise.all([params, headers()]);
  if (!isLang(lang)) notFound();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  return (
    <html lang={lang} suppressHydrationWarning>
      <head><script {...(nonce === undefined ? {} : { nonce })} dangerouslySetInnerHTML={{ __html: OFFLINE_BOOTSTRAP }} /></head>
      <body>
        <ThemeProvider {...(nonce === undefined ? {} : { nonce })}>
          <AutoRefreshProvider>
            <AppShell lang={lang}>{children}</AppShell>
            <ServiceWorkerRegister />
          </AutoRefreshProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
