/*
  The brand faces, loaded once for every route (main.tsx calls this before the first render), so the dashboard
  at /live can set its headline in the same display serif as the landing page:
    font-family: "Imbue", "Didot", "Bodoni 72", serif; font-optical-sizing: auto;
  Imbue (opsz 10..100, wght 300..700) is the display face; Albert Sans (400..600) the landing's text face.
*/
const HREF =
  "https://fonts.googleapis.com/css2?family=Imbue:opsz,wght@10..100,300..700&family=Albert+Sans:wght@400;500;600&display=swap";

export function loadBrandFonts() {
  if (typeof document === "undefined" || document.querySelector("link[data-brand-fonts]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = HREF;
  link.dataset.brandFonts = "";
  document.head.appendChild(link);
}
