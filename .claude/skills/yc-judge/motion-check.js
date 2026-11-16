(async () => {
  // Samples motion for ~3 s: running CSS/WAAPI animations, infinite loops, slow transitions, layout shift, frame pacing.
  const label = (el) => !el ? '?' : (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ' "' + (el.innerText || el.getAttribute?.('aria-label') || '').trim().slice(0, 24) + '"');
  const anims = document.getAnimations().map((a) => {
    const t = a.effect?.getTiming?.() || {};
    return { name: a.animationName || a.transitionProperty || a.constructor.name, ms: Number(t.duration) || 0, iterations: t.iterations, easing: t.easing, target: label(a.effect?.target) };
  });
  let cls = 0; const shifts = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) { cls += e.value; if (e.value > 0.01) shifts.push(e.value.toFixed(3) + ' ' + (e.sources || []).map((s) => label(s.node)).join(' + ').slice(0, 80)); } } }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  const frames = []; let last = performance.now(); const end = last + 3000;
  await new Promise((res) => { const tick = (t) => { frames.push(t - last); last = t; t < end ? requestAnimationFrame(tick) : res(); }; requestAnimationFrame(tick); });
  frames.sort((a, b) => a - b);
  const p = (q) => frames.length ? Math.round(frames[Math.min(frames.length - 1, Math.floor(q * frames.length))]) : 0;
  let longTasks = 0; try { longTasks = performance.getEntriesByType('longtask').length; } catch (e) {}
  const infinite = anims.filter((a) => a.iterations === Infinity);
  const slow = anims.filter((a) => a.ms > 400 && a.iterations !== Infinity);
  return JSON.stringify({
    runningAnimations: anims.length,
    infiniteLoops: infinite.slice(0, 12),
    slowOver400ms: slow.slice(0, 12),
    clsSinceLoad: Number(cls.toFixed(3)), bigShifts: shifts.slice(0, 10),
    frameMs: { p50: p(0.5), p95: p(0.95), max: p(1), over50ms: frames.filter((f) => f > 50).length, frames: frames.length },
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }, null, 1);
})()
