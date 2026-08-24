"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppHeader } from "./app-header";
import type { Lang } from "@/lib/domain/contracts";
import { getMessages } from "@/lib/i18n";

export function AppShell({ lang, children }: { readonly lang: Lang; readonly children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div lang={lang}>
      <AppHeader lang={lang} messages={getMessages(lang)} pathname={pathname} />
      <main>{children}</main>
    </div>
  );
}
