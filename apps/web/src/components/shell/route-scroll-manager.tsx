"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

function scrollToTopImmediately(): void {
  const root = document.documentElement;
  const previousBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = "auto";
  window.scrollTo(0, 0);
  root.style.scrollBehavior = previousBehavior;
}

export function RouteScrollManager() {
  const pathname = usePathname();
  const previousPathname = useRef(pathname);
  const popstateNavigation = useRef(false);

  useEffect(() => {
    const onPopState = () => {
      popstateNavigation.current = true;
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    const preserveBrowserScroll = popstateNavigation.current;
    popstateNavigation.current = false;
    if (preserveBrowserScroll) return;

    const frame = window.requestAnimationFrame(scrollToTopImmediately);
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  return null;
}
