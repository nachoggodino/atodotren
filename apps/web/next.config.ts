import type { NextConfig } from "next";

const standaloneBuild = process.env.NEXT_BUILD_TARGET === "standalone";

const nextConfig: NextConfig = {
  ...(standaloneBuild ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["pg"],
  async redirects() {
    return [{ source: "/", destination: "/es", permanent: false }];
  },
};

export default nextConfig;
