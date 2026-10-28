import type { MetadataRoute } from "next";

import { getApplicationUrl } from "@/lib/auth/site-url";

// Account, management and authentication surfaces are private; booking selections are query variants of /book.
const privatePaths = [
  "/account", "/admin", "/coach$", "/coach/", "/messages", "/my-activity", "/profile", "/reservations",
  "/auth", "/api", "/login", "/signup", "/forgot-password", "/reset-password", "/book?",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: privatePaths },
    ...(process.env.APP_URL && { sitemap: getApplicationUrl("/sitemap.xml") }),
  };
}
