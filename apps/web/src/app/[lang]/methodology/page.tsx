import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { metadataCopy } from "@/messages/metadata";
import { methodologyCopy } from "@/messages/methodology";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const copy = metadataCopy[lang];
  return localizedPageMetadata({ lang, paths: sharedLocalizedPath("/methodology"), title: copy.methodologyTitle, description: copy.methodologyDescription });
}

export default async function MethodologyPage({ params }: { readonly params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const copy = methodologyCopy[lang];
  return (
    <article className="page-shell pb-20 pt-12">
      <p className="eyebrow">{copy.kicker}</p>
      <h1 className="mt-3 max-w-4xl text-5xl font-black tracking-[-.055em] sm:text-7xl">{copy.title}</h1>
      <p className="mt-6 max-w-3xl text-xl leading-8 text-muted">{copy.intro}</p>
      <div className="mt-14 max-w-3xl divide-y divide-border border-y border-border">
        {copy.sections.map((section) => (
          <section className="grid gap-4 py-8 sm:grid-cols-[13rem_1fr]" key={section.title}>
            <h2 className="text-lg font-black">{section.title}</h2>
            <div className="space-y-4">{section.paragraphs.map((paragraph) => <p className="leading-7 text-muted" key={paragraph}>{paragraph}</p>)}</div>
          </section>
        ))}
      </div>
    </article>
  );
}
