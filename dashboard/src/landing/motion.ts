import { useEffect, type RefObject } from "react";

/*
  The two pointer-driven touches on the landing page, both tiny and damped, both pointer-only and off under
  prefers-reduced-motion. Each writes one transform per frame straight to the element (never React state), and
  its rAF loop stops as soon as the element is back at rest, so nothing runs while the pointer is still.
*/

const canHover = () =>
  window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Magnetic pull: inside a radius of 1.6x the element's size the element leans toward the pointer, at most `max` px.
 * Written to the `translate` property so it composes with the CSS hover lift and press scale on `transform`.
 */
export function useMagnetic(ref: RefObject<HTMLElement | null>, max = 4) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !canHover()) return;
    let raf = 0;
    const cur = { x: 0, y: 0 };
    const tgt = { x: 0, y: 0 };
    const step = () => {
      cur.x += (tgt.x - cur.x) * 0.22;
      cur.y += (tgt.y - cur.y) * 0.22;
      const still = Math.abs(tgt.x - cur.x) < 0.05 && Math.abs(tgt.y - cur.y) < 0.05;
      if (still) {
        cur.x = tgt.x;
        cur.y = tgt.y;
      }
      el.style.translate = cur.x || cur.y ? `${cur.x.toFixed(2)}px ${cur.y.toFixed(2)}px` : "";
      raf = still ? 0 : requestAnimationFrame(step);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(step);
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const radius = Math.max(r.width, r.height) * 1.6;
      const d = Math.hypot(dx, dy);
      const pull = d < radius ? 1 - d / radius : 0;
      const clamp = (v: number) => Math.max(-max, Math.min(max, v));
      // A tenth of the offset, fading to nothing at the radius, never more than `max` px.
      tgt.x = clamp(dx * 0.1 * pull);
      tgt.y = clamp(dy * 0.1 * pull);
      kick();
    };
    const onLeave = () => {
      tgt.x = 0;
      tgt.y = 0;
      kick();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      el.style.translate = "";
    };
  }, [ref, max]);
}

/**
 * Tilt toward the pointer: while the pointer is inside `area`, each element matching `selector` turns up to `max`
 * degrees toward it (a 3D lean, damped), and settles flat when the pointer leaves.
 */
export function useTilt(area: RefObject<HTMLElement | null>, selector: string, max = 2) {
  useEffect(() => {
    const root = area.current;
    if (!root || !canHover()) return;
    const els = [...root.querySelectorAll<HTMLElement>(selector)];
    const state = els.map(() => ({ rx: 0, ry: 0, tx: 0, ty: 0 }));
    let raf = 0;
    const step = () => {
      let moving = false;
      els.forEach((el, i) => {
        const s = state[i];
        s.rx += (s.tx - s.rx) * 0.22;
        s.ry += (s.ty - s.ry) * 0.22;
        if (Math.abs(s.tx - s.rx) > 0.005 || Math.abs(s.ty - s.ry) > 0.005) moving = true;
        else {
          s.rx = s.tx;
          s.ry = s.ty;
        }
        el.style.transform =
          s.rx || s.ry ? `perspective(900px) rotateX(${s.rx.toFixed(3)}deg) rotateY(${s.ry.toFixed(3)}deg)` : "";
      });
      raf = moving ? requestAnimationFrame(step) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(step);
    };
    const onMove = (e: PointerEvent) => {
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const nx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2)));
        const ny = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2)));
        // Lean the near edge toward the pointer.
        state[i].ty = nx * max;
        state[i].tx = -ny * max;
      });
      kick();
    };
    const onLeave = () => {
      state.forEach((s) => {
        s.tx = 0;
        s.ty = 0;
      });
      kick();
    };
    root.addEventListener("pointermove", onMove, { passive: true });
    root.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      els.forEach((el) => (el.style.transform = ""));
    };
  }, [area, selector, max]);
}
