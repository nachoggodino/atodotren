export const FORWARD_ROUTE_NAVIGATION_EVENT = "atodotren:forward-route-navigation";

export function announceForwardRouteNavigation(): void {
  window.dispatchEvent(new Event(FORWARD_ROUTE_NAVIGATION_EVENT));
}
