import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { loadBrandFonts } from "./landing/fonts.ts";
import { Root } from "./landing/Root.tsx";

// Imbue and Albert Sans for both routes: the landing page and the dashboard's display headline.
loadBrandFonts();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
