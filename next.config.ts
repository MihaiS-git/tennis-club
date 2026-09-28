import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};

export default nextConfig;
