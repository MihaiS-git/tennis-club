import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.TEST_SUPABASE_PROJECT === "tennis-club-tests" ? ".next-test" : ".next",
  cacheComponents: true,
  partialPrefetching: false,
  serverExternalPackages: ["typeorm"],
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};

export default nextConfig;
