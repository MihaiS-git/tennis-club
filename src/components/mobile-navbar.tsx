import { readNavigationProfile } from "@/lib/profile/navigation";
import { MobileNavbarMenu } from "./mobile-navbar-menu";

export async function MobileNavbar() {
  const { account, avatarUrl } = await readNavigationProfile();

  return (
    <MobileNavbarMenu
      isAuthenticated={account.state !== "unauthenticated"}
      isAdmin={account.state === "active" && account.roles.includes("admin")}
      avatarUrl={avatarUrl}
    />
  );
}
