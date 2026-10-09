import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  serverExternalPackages: ["typeorm"],
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};

export default nextConfig;
