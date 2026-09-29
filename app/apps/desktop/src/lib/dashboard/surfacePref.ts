/**
 * Dashboard vs Text, remembered per note path in `localStorage` — "I want to
 * see the markdown of this one dashboard" is a property of that dashboard,
 * not a mode the whole app should sit in (the Boards rule). A denied or
 * missing storage falls back to the dashboard.
 */
export type DashboardSurfaceView = "dashboard" | "text";

export const dashboardViewKey = (path: string) => `noam:dashboard-view:${path}`;

export function rememberedDashboardView(path: string): DashboardSurfaceView {
  try {
    return localStorage.getItem(dashboardViewKey(path)) === "text" ? "text" : "dashboard";
  } catch {
    return "dashboard";
  }
}

export function rememberDashboardView(path: string, view: DashboardSurfaceView): void {
  try {
    localStorage.setItem(dashboardViewKey(path), view);
  } catch {
    // A denied storage quota is not a reason to refuse the toggle.
  }
}
