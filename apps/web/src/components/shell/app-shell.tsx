"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { OfflineStatus } from "@/components/feedback/offline-status";
import { AppHeader } from "./app-header";
import type { Lang } from "@/lib/domain/contracts";
import { getMessages } from "@/lib/i18n";

export function AppShell({ lang, children }: { readonly lang: Lang; readonly children: ReactNode }) {
  const pathname = usePathname();
  const messages = getMessages(lang);
  return <div lang={lang}><AppHeader lang={lang} messages={messages} pathname={pathname} /><main>{children}</main><OfflineStatus messages={messages} /></div>;
}
