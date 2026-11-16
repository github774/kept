import { Suspense, lazy } from "react";
import { isLivePath, usePath } from "./route.ts";

// "/" is the landing page, "/live" the dashboard. Each is its own chunk, so neither pays for the other.
const App = lazy(() => import("../App.tsx"));
const Landing = lazy(() => import("./Landing.tsx"));

export function Root() {
  const path = usePath();
  return <Suspense fallback={null}>{isLivePath(path) ? <App /> : <Landing />}</Suspense>;
}
