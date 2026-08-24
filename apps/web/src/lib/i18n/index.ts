import { en } from "@/messages/en";
import { es } from "@/messages/es";
import type { Messages } from "@/messages/types";
import type { Lang } from "@/lib/domain/contracts";

export const LANGUAGES: readonly Lang[] = ["es", "en"];
export const DEFAULT_LANG: Lang = "es";

export function isLang(value: string): value is Lang {
  return LANGUAGES.includes(value as Lang);
}

export function getMessages(lang: Lang): Messages {
  return lang === "en" ? en : es;
}

export function localized<T extends { readonly es: string; readonly en: string }>(value: T, lang: Lang): string {
  return value[lang];
}
