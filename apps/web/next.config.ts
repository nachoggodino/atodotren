import type { NextConfig } from "next";

const standaloneBuild = process.env.NEXT_BUILD_TARGET === "standalone";

const nextConfig: NextConfig = {
  ...(standaloneBuild ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["pg"],
  async redirects() {
    return [
      { source: "/", destination: "/es", permanent: false },
      { source: "/:lang/history", destination: "/:lang/explore", permanent: true },
      { source: "/:lang/history/:path*", destination: "/:lang/explore/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
