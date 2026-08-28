import { en } from "@/messages/en";
import { es } from "@/messages/es";
import type { Messages } from "@/messages/types";
import type { Lang } from "@/lib/domain/contracts";

export const LANGUAGE_OPTIONS = [
  { lang: "es", shortLabel: "ESP" },
  { lang: "en", shortLabel: "ENG" },
] as const satisfies readonly { readonly lang: Lang; readonly shortLabel: string }[];

export const LANGUAGES: readonly Lang[] = LANGUAGE_OPTIONS.map(({ lang }) => lang);
export const DEFAULT_LANG: Lang = "es";

export function isLang(value: string): value is Lang {
  return LANGUAGES.includes(value as Lang);
}

export function localizedPath(pathname: string, lang: Lang): string {
  const parts = pathname.split("/");
  if (isLang(parts[1] ?? "")) parts[1] = lang;
  else parts.splice(1, 0, lang);
  return parts.join("/") || `/${lang}`;
}

export function getMessages(lang: Lang): Messages {
  return lang === "en" ? en : es;
}

export function localized<T extends { readonly es: string; readonly en: string }>(value: T, lang: Lang): string {
  return value[lang];
}
