import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand/config";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.shortName,
    description: BRAND.descriptionEs,
    start_url: "/es",
    display: "standalone",
    background_color: BRAND.themeColorLight,
    theme_color: BRAND.themeColorLight,
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }, { src: "/maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }],
  };
}
