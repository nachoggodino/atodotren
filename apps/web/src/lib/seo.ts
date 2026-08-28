import type { Metadata } from "next";
import type { Lang, LocalizedSlug } from "./domain/contracts";

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env.WEB_PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const value = new URL(raw);
    return value.protocol === "https:" || value.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

export function localizedPageMetadata(input: { readonly lang: Lang; readonly paths: LocalizedSlug; readonly title: string; readonly description: string }): Metadata {
  const base = publicBaseUrl();
  const localizedPath = `/${input.lang}${input.paths[input.lang]}`;
  return {
    title: input.title,
    description: input.description,
    ...(base === null ? {} : {
      alternates: {
        canonical: new URL(localizedPath, base),
        languages: {
          es: new URL(`/es${input.paths.es}`, base),
          en: new URL(`/en${input.paths.en}`, base),
          "x-default": new URL(`/es${input.paths.es}`, base),
        },
      },
    }),
  };
}

export function sharedLocalizedPath(path: string): LocalizedSlug {
  return { es: path, en: path };
}
