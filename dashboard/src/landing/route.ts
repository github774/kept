import { useSyncExternalStore } from "react";

/*
  A pathname router small enough to read in one breath: "/" is the landing page, "/live" is the dashboard.
  navigate() pushes history and tells every subscriber; the back button works through popstate.
*/

const EVENT = "ss:navigate";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

const getPath = () => window.location.pathname;

export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath, getPath);
}

export function navigate(path: string) {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", path);
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event(EVENT));
}

/** Where every "watch it live" goes: the dashboard, opened on the Team view. */
export const LIVE_URL = "/live?view=team";

export const isLivePath = (path: string) => path === "/live" || path.startsWith("/live/");

/** Warm the dashboard chunk so the hand-off to /live has nothing to wait for. */
let warmed: Promise<unknown> | null = null;
export function preloadLive() {
  warmed ??= import("../App.tsx");
  return warmed;
}
