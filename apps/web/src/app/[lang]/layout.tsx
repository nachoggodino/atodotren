import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { isLang, LANGUAGES } from "@/lib/i18n";

export function generateStaticParams() { return LANGUAGES.map((lang) => ({ lang })); }

export default async function LangLayout({ children, params }: { readonly children: ReactNode; readonly params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return <AppShell lang={lang}>{children}</AppShell>;
}
