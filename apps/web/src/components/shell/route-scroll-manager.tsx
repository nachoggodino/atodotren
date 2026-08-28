"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { FORWARD_ROUTE_NAVIGATION_EVENT } from "@/lib/navigation-events";

function scrollImmediately(top: number): void {
  const root = document.documentElement;
  const previousBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = "auto";
  window.scrollTo(0, top);
  root.style.scrollBehavior = previousBehavior;
}

function internalPathForAnchor(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return null;
  return url.pathname;
}

export function RouteScrollManager() {
  const pathname = usePathname();
  const currentPathname = useRef(pathname);
  const positions = useRef(new Map<string, number>());
  const forwardNavigationPending = useRef(false);
  const popstateNavigation = useRef(false);

  useEffect(() => {
    const rememberCurrentPosition = () => {
      positions.current.set(currentPathname.current, window.scrollY);
    };
    const prepareForwardNavigation = () => {
      rememberCurrentPosition();
      forwardNavigationPending.current = true;
    };
    const onDocumentClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (internalPathForAnchor(event.target) !== null) prepareForwardNavigation();
    };
    const onScroll = () => {
      if (!forwardNavigationPending.current) rememberCurrentPosition();
    };
    const onPopState = () => {
      rememberCurrentPosition();
      forwardNavigationPending.current = false;
      popstateNavigation.current = true;
    };

    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onPopState);
    window.addEventListener(FORWARD_ROUTE_NAVIGATION_EVENT, prepareForwardNavigation);
    return () => {
      document.removeEventListener("click", onDocumentClick, true);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(FORWARD_ROUTE_NAVIGATION_EVENT, prepareForwardNavigation);
    };
  }, []);

  useEffect(() => {
    if (currentPathname.current === pathname) return;
    currentPathname.current = pathname;
    const restoreHistoryPosition = popstateNavigation.current;
    popstateNavigation.current = false;
    forwardNavigationPending.current = false;
    const targetTop = restoreHistoryPosition ? positions.current.get(pathname) ?? 0 : 0;
    const frame = window.requestAnimationFrame(() => scrollImmediately(targetTop));
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  return null;
}
