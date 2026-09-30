import { readNavigationProfile } from "@/lib/profile/navigation";
import { MobileNavbarControls } from "./mobile-navbar-menu";

export function MobileNavbarFallback() {
  return <span aria-hidden="true" className="size-10 rounded-control border border-border bg-surface-muted" />;
}

export async function MobileNavbar() {
  const { account, avatarUrl } = await readNavigationProfile();

  return (
    <MobileNavbarControls
      isAuthenticated={account.state !== "unauthenticated"}
      isAdmin={account.state === "active" && account.roles.includes("admin")}
      avatarUrl={avatarUrl}
    />
  );
}
