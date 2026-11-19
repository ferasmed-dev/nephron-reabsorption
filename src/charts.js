// Dependency-free SVG charts: line (with crosshair tooltip) and diverging bars
// (with per-bar tooltip). Colours come from CSS custom properties so light/dark
// modes are chosen in styles.css.

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceStep(range, target = 5) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const step = r >= 5 ? 10 : r >= 2 ? 5 : r >= 1 ? 2 : 1;
  return step * mag;
}

export function linearTicks(min, max, target = 5) {
  if (max === min) max = min + 1;
  const step = niceStep(max - min, target);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

function logTicks(min, max) {
  const out = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) out.push(Math.pow(10, e));
  return out;
}

function setupTooltip(wrap) {
  let tip = wrap.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    wrap.appendChild(tip);
  }
  return tip;
}

function placeTip(tip, wrap, x, y) {
  const w = wrap.clientWidth;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  let left = x + 12;
  if (left + tw > w - 4) left = x - tw - 12;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(0, y - 10)}px`;
}

/**
 * Line chart. opts: { categories, series:[{name, values, cls, dashed}], yMin, yMax,
 * log, yFmt(v), tip(i) -> html, ariaLabel }
 */
export function lineChart(wrap, opts) {
  const W = Math.max(300, wrap.clientWidth || 600);
  const H = opts.height || 250;
  const m = { t: 14, r: 16, b: 46, l: 56 };
  const svgOld = wrap.querySelector('svg');
  if (svgOld) svgOld.remove();
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.ariaLabel || '' });
  wrap.prepend(svg);
  const n = opts.categories.length;
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const x = (i) => m.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));

  const all = opts.series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  let yMin = opts.yMin ?? Math.min(0, ...all);
  let yMax = opts.yMax ?? Math.max(...all) * 1.08;
  let ticks; let y;
  if (opts.log) {
    const pos = all.filter((v) => v > 0);
    yMin = Math.max(1e-4, Math.min(...pos) * 0.7);
    yMax = Math.max(...pos) * 1.4;
    ticks = logTicks(yMin, yMax).filter((v) => v >= yMin * 0.999 && v <= yMax * 1.001);
    const l0 = Math.log10(yMin); const l1 = Math.log10(yMax);
    y = (v) => m.t + ih - ((Math.log10(Math.max(v, yMin)) - l0) / (l1 - l0)) * ih;
  } else {
    ticks = linearTicks(yMin, yMax, 5);
    yMin = ticks[0]; yMax = ticks[ticks.length - 1];
    y = (v) => m.t + ih - ((v - yMin) / (yMax - yMin)) * ih;
  }

  const g = el('g', { class: 'axis' }, svg);
  for (const tv of ticks) {
    const yy = y(tv);
    el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: 'grid' }, g);
    const tx = el('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, g);
    tx.textContent = opts.yFmt ? opts.yFmt(tv) : tv;
  }
  opts.categories.forEach((c, i) => {
    const tx = el('text', { x: x(i), y: H - m.b + 18, 'text-anchor': 'middle', class: 'tick' }, g);
    tx.textContent = c;
  });
  el('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'baseline' }, g);

  // series: later series drawn on top
  opts.series.forEach((s) => {
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    el('polyline', { points: pts, class: `series ${s.cls}${s.dashed ? ' dashed' : ''}`, fill: 'none' }, svg);
    if (!s.dashed) {
      s.values.forEach((v, i) => el('circle', { cx: x(i), cy: y(v), r: 4, class: `dot ${s.cls}` }, svg));
    }
  });

  // direct label of the last value of the first series
  const s0 = opts.series[0];
  if (s0 && opts.endLabel) {
    const lv = s0.values[n - 1];
    const lab = el('text', { x: x(n - 1) - 6, y: y(lv) - 10, 'text-anchor': 'end', class: 'endlabel' }, svg);
    lab.textContent = opts.endLabel;
  }

  // hover layer
  const tip = setupTooltip(wrap);
  const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' }, svg);
  const colW = n > 1 ? iw / (n - 1) : iw;
  opts.categories.forEach((c, i) => {
    const r = el('rect', { x: x(i) - colW / 2, y: m.t, width: colW, height: ih + 24, fill: 'transparent', class: 'hit' }, svg);
    const show = () => {
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      tip.innerHTML = opts.tip(i);
      placeTip(tip, wrap, x(i) * (wrap.clientWidth / W), y(s0.values[i]) * (wrap.clientWidth / W));
    };
    r.addEventListener('mousemove', show);
    r.addEventListener('mouseenter', show);
    r.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  });
  return svg;
}

/**
 * Diverging bar chart (positive = reabsorption, negative = secretion) with ghost
 * outline bars for a comparison scenario. opts: { categories, values, ghost, yFmt, tip(i) }
 */
export function barChart(wrap, opts) {
  const W = Math.max(300, wrap.clientWidth || 600);
  const H = opts.height || 240;
  const m = { t: 18, r: 12, b: 34, l: 56 };
  const svgOld = wrap.querySelector('svg');
  if (svgOld) svgOld.remove();
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.ariaLabel || '' });
  wrap.prepend(svg);
  const n = opts.categories.length;
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const vals = [...opts.values, ...(opts.ghost || [])];
  const hi = Math.max(0.05, ...vals);
  const ticks = linearTicks(Math.min(0, ...vals), hi > 0.9 && hi <= 1 ? 1 : hi * 1.08, 4);
  const yMin = ticks[0]; const yMax = ticks[ticks.length - 1];
  const y = (v) => m.t + ih - ((v - yMin) / (yMax - yMin)) * ih;
  const band = iw / n;
  const bw = Math.min(46, band * 0.56);
  const cx = (i) => m.l + band * i + band / 2;

  const g = el('g', { class: 'axis' }, svg);
  for (const tv of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(tv), y2: y(tv), class: 'grid' }, g);
    const tx = el('text', { x: m.l - 8, y: y(tv) + 4, 'text-anchor': 'end', class: 'tick' }, g);
    tx.textContent = opts.yFmt(tv);
  }
  opts.categories.forEach((c, i) => {
    const tx = el('text', { x: cx(i), y: H - m.b + 18, 'text-anchor': 'middle', class: 'tick' }, g);
    tx.textContent = c;
  });

  const r4 = 4;
  const barPath = (x0, w, v) => {
    // rounded data end (away from the zero line), square at the baseline
    const y0 = y(0); const y1 = y(v);
    const h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    const r = Math.min(r4, h, w / 2);
    if (v >= 0) {
      return `M${x0},${y0} V${y1 + r} Q${x0},${y1} ${x0 + r},${y1} H${x0 + w - r} Q${x0 + w},${y1} ${x0 + w},${y1 + r} V${y0} Z`;
    }
    return `M${x0},${y0} V${y1 - r} Q${x0},${y1} ${x0 + r},${y1} H${x0 + w - r} Q${x0 + w},${y1} ${x0 + w},${y1 - r} V${y0} Z`;
  };

  opts.values.forEach((v, i) => {
    const d = barPath(cx(i) - bw / 2, bw, v);
    if (d) el('path', { d, class: v >= 0 ? 'bar pos' : 'bar neg' }, svg);
  });
  if (opts.ghost) {
    opts.ghost.forEach((v, i) => {
      const d = barPath(cx(i) - bw / 2 - 3, bw + 6, v);
      if (d) el('path', { d, class: 'bar ghost', fill: 'none' }, svg);
    });
  }
  // selective direct labels: values ≥ 5 % of filtered or secretion
  opts.values.forEach((v, i) => {
    if (Math.abs(v) < 0.05 && v >= 0) return;
    const tx = el('text', { x: cx(i), y: v >= 0 ? y(v) - 6 : y(v) + 14, 'text-anchor': 'middle', class: 'barlabel' }, svg);
    tx.textContent = opts.labelFmt(v);
  });
  el('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }, svg);

  const tip = setupTooltip(wrap);
  opts.categories.forEach((c, i) => {
    const r = el('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, fill: 'transparent', class: 'hit' }, svg);
    const show = () => {
      tip.innerHTML = opts.tip(i);
      const k = wrap.clientWidth / W;
      placeTip(tip, wrap, cx(i) * k, y(Math.max(0, opts.values[i])) * k);
    };
    r.addEventListener('mousemove', show);
    r.addEventListener('mouseenter', show);
    r.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
  return svg;
}
