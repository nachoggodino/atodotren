import type { Messages } from "@/messages/types";

export function InvalidHistoryFilters({ messages }: { readonly messages: Messages }) {
  return <div className="page-shell pb-20 pt-12"><div className="rounded-xl border border-warning/40 bg-warning/10 p-6"><h1 className="text-2xl font-black">{messages.errors.invalidFilters}</h1><p className="mt-2 text-sm text-muted">{messages.history.filters}</p></div></div>;
}
