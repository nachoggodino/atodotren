import type { ReactNode } from "react";
import { OfflineStatus } from "@/components/feedback/offline-status";
import type { Lang } from "@/lib/domain/contracts";
import { getMessages } from "@/lib/i18n";
import { AppHeader } from "./app-header";

export function AppShell({ lang, children }: { readonly lang: Lang; readonly children: ReactNode }) {
  const messages = getMessages(lang);
  return <div><AppHeader lang={lang} messages={messages} /><main>{children}</main><OfflineStatus messages={messages} /></div>;
}
