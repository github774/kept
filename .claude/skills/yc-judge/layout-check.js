(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
  const txt = (e) => (e.innerText || '').trim().replace(/\s+/g, ' ');
  const out = { viewport: innerWidth + 'x' + innerHeight, pageScrolls: document.documentElement.scrollHeight > innerHeight + 4, collapsed: [], truncated: [], headingOverlaps: [], tinyText: [], minFontPx: 99, panels: 0 };
  for (const e of document.querySelectorAll('section,[data-area]')) {
    const r = e.getBoundingClientRect();
    if (e.tagName === 'SECTION' && r.height >= 40) out.panels++;
    if (r.width > 0 && r.height < 40 && txt(e).length > 20) out.collapsed.push(Math.round(r.height) + 'px: ' + txt(e).slice(0, 50));
  }
  for (const e of document.querySelectorAll('body *')) {
    if (e.children.length || !txt(e) || !vis(e)) continue;
    const s = getComputedStyle(e); const fs = parseFloat(s.fontSize);
    out.minFontPx = Math.min(out.minFontPx, fs);
    if (fs < 14) out.tinyText.push(fs + 'px ' + txt(e).slice(0, 30));
    if (e.scrollWidth > e.clientWidth + 1 && (s.textOverflow === 'ellipsis' || s.overflow === 'hidden')) out.truncated.push(txt(e).slice(0, 50));
  }
  const hs = [...document.querySelectorAll('h1,h2,h3,h4')].filter(vis).map((h) => [txt(h), h.getBoundingClientRect()]);
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
    const a = hs[i][1], b = hs[j][1];
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.headingOverlaps.push(hs[i][0].slice(0, 25) + ' X ' + hs[j][0].slice(0, 25));
  }
  const secs = [...document.querySelectorAll('section,[data-area]')].filter(vis).filter((e) => e.getBoundingClientRect().height >= 40);
  out.panelOverlaps = [];
  for (let i = 0; i < secs.length; i++) for (let j = i + 1; j < secs.length; j++) {
    const A = secs[i], B = secs[j]; if (A.contains(B) || B.contains(A)) continue;
    const a = A.getBoundingClientRect(), b = B.getBoundingClientRect();
    const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ix > 8 && iy > 8) out.panelOverlaps.push(txt(A).slice(0, 25) + ' X ' + txt(B).slice(0, 25) + ' (' + Math.round(ix) + 'x' + Math.round(iy) + ')');
  }
  out.panelOverlaps = out.panelOverlaps.slice(0, 15);
  out.clamped = [];
  for (const e of document.querySelectorAll('p,li,span,div')) { if (!vis(e) || e.children.length > 2) continue; const s = getComputedStyle(e); if ((s.webkitLineClamp && s.webkitLineClamp !== 'none') && e.scrollHeight > e.clientHeight + 2) out.clamped.push(txt(e).slice(0, 50)); }
  out.clamped = [...new Set(out.clamped)].slice(0, 15);
  out.tinyText = [...new Set(out.tinyText)].slice(0, 20); out.truncated = [...new Set(out.truncated)].slice(0, 20);
  return JSON.stringify(out, null, 1);
})()
