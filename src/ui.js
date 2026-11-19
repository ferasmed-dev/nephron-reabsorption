import {
  simulate, presetParams, mergeParams, effectiveActivity, segmentFractions, remainingProfile,
  SEGMENTS, SUBSTANCES, UNITS, PRESET_KEYS, REFERENCE, GLUCOSE_MG_PER_MMOL,
} from './model.js';
import { t, detectLang, LANGS } from './i18n.js';
import { lineChart, barChart } from './charts.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ state
let stored = null;
try { stored = localStorage.getItem('nephron-lang'); } catch { /* storage unavailable */ }
const qs = new URLSearchParams(location.search);

const state = {
  lang: detectLang(location.search, stored, navigator.language),
  presetKey: PRESET_KEYS.includes(qs.get('preset')) ? qs.get('preset') : 'normal',
  params: null,
  sub: SUBSTANCES.includes(qs.get('sub')) ? qs.get('sub') : 'na',
  seg: SEGMENTS.includes(qs.get('seg')) ? qs.get('seg') : 'pct',
  logScale: false,
  animate: !reduceMotion,
  log: [],
};
state.params = presetParams(state.presetKey);
const NORMAL = simulate(presetParams('normal'));
let R = simulate(state.params);
let T = t(state.lang);

// ------------------------------------------------------------------ formatting
const nf = (x, dp = 0) => new Intl.NumberFormat(T.locale, { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(x);
function pctDp(frac) {
  const a = Math.abs(frac * 100);
  if (a === 0) return 0;
  if (a < 1) return 2;
  if (a < 10) return 1;
  return 0;
}
const pct = (frac) => `${nf(frac * 100, pctDp(frac))} %`;
const F = { n: nf, pct };

function amount(sub, v) {
  if (sub === 'glucose') {
    const g = (v * GLUCOSE_MG_PER_MMOL) / 1000;
    return `${nf(g, g < 10 ? 2 : g < 100 ? 1 : 0)} ${T.units.g}`;
  }
  const u = T.units[UNITS[sub]];
  const a = Math.abs(v);
  const dp = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return `${nf(v, dp)} ${u}`;
}
const subName = (s) => T.sub[s];
const segAbbr = (s) => T.seg[s][1];
const segName = (s) => T.seg[s][0];

function hormoneWord(v) {
  const w = T.hormoneScale;
  if (v <= 0.02) return w[0];
  if (v < 0.35) return w[1];
  if (v <= 0.68) return w[2];
  if (v < 0.97) return w[3];
  return w[4];
}

// ------------------------------------------------------------------ controls config
const SLIDERS = {
  hormones: [
    { key: 'adh', label: () => T.adh, min: 0, max: 1, step: 0.05, get: (p) => p.adh, set: (p, v) => { p.adh = v; }, fmt: hormoneWord },
    { key: 'aldo', label: () => T.aldo, min: 0, max: 1, step: 0.05, get: (p) => p.aldo, set: (p, v) => { p.aldo = v; }, fmt: hormoneWord },
    { key: 'pth', label: () => T.pth, min: 0, max: 1, step: 0.05, get: (p) => p.pth, set: (p, v) => { p.pth = v; }, fmt: hormoneWord },
  ],
  plasma: [
    { key: 'gfr', label: () => T.gfr, min: 10, max: 180, step: 5, get: (p) => p.gfr, set: (p, v) => { p.gfr = v; }, fmt: (v) => `${nf(v)} mL/min` },
    { key: 'glucose', label: () => T.glucose, min: 60, max: 600, step: 10, get: (p) => p.plasma.glucose, set: (p, v) => { p.plasma.glucose = v; }, fmt: (v) => `${nf(v)} mg/dL` },
    { key: 'k', label: () => T.kPlasma, min: 2.5, max: 7, step: 0.1, get: (p) => p.plasma.k, set: (p, v) => { p.plasma.k = v; }, fmt: (v) => `${nf(v, 1)} mmol/L` },
    { key: 'ca', label: () => T.caPlasma, min: 1.8, max: 3.6, step: 0.05, get: (p) => p.plasma.ca, set: (p, v) => { p.plasma.ca = v; }, fmt: (v) => `${nf(v, 2)} mmol/L` },
    { key: 'pi', label: () => T.piPlasma, min: 0.4, max: 3, step: 0.05, get: (p) => p.plasma.pi, set: (p, v) => { p.plasma.pi = v; }, fmt: (v) => `${nf(v, 2)} mmol/L` },
  ],
};
const ALL_SLIDERS = [...SLIDERS.hormones, ...SLIDERS.plasma];
const DRUG_KEYS = ['furosemide', 'thiazide', 'amiloride', 'spironolactone', 'acetazolamide', 'sglt2i'];

function buildControls() {
  // presets
  const sel = $('#preset');
  sel.innerHTML = '';
  for (const k of PRESET_KEYS) {
    const o = document.createElement('option');
    o.value = k; o.textContent = T.presets[k][0];
    sel.appendChild(o);
  }
  sel.value = state.presetKey;

  // substances
  const subs = $('#subs');
  subs.innerHTML = '';
  for (const s of SUBSTANCES) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.dataset.sub = s;
    b.setAttribute('role', 'radio');
    b.textContent = subName(s);
    b.addEventListener('click', () => setSub(s));
    subs.appendChild(b);
  }

  // sliders
  for (const [group, list] of Object.entries(SLIDERS)) {
    const box = $(`#${group}`);
    box.innerHTML = '';
    for (const sd of list) {
      const wrap = document.createElement('div');
      wrap.className = 'slider';
      const id = `sl-${sd.key}`;
      wrap.innerHTML = `<label class="lab" for="${id}"><span></span><span class="val"></span></label>
        <input type="range" id="${id}" min="${sd.min}" max="${sd.max}" step="${sd.step}">`;
      const input = wrap.querySelector('input');
      let from = null;
      const startEdit = () => { if (from === null) from = sd.get(state.params); };
      input.addEventListener('pointerdown', startEdit);
      input.addEventListener('keydown', startEdit);
      input.addEventListener('focus', startEdit);
      input.addEventListener('input', () => {
        startEdit();
        sd.set(state.params, parseFloat(input.value));
        render();
      });
      input.addEventListener('change', () => {
        const to = sd.get(state.params);
        if (from !== null && from !== to) {
          addLog({ kind: 'slider', key: sd.key, from, to }, simulateFrom(state.params, sd, from));
        }
        from = null;
      });
      box.appendChild(wrap);
    }
  }

  // drugs
  const drugs = $('#drugs');
  drugs.innerHTML = '';
  for (const d of DRUG_KEYS) {
    const lab = document.createElement('label');
    lab.className = 'toggle';
    lab.innerHTML = `<input type="checkbox" data-drug="${d}"><span><span class="dn"></span><small></small></span>`;
    const cb = lab.querySelector('input');
    cb.addEventListener('change', () => {
      const before = R;
      state.params.drugs[d] = cb.checked;
      render();
      addLog({ kind: cb.checked ? 'drugOn' : 'drugOff', drug: d }, before);
    });
    drugs.appendChild(lab);
  }
}

function simulateFrom(params, sd, fromValue) {
  const p = JSON.parse(JSON.stringify(params));
  sd.set(p, fromValue);
  return simulate(p);
}

function syncControls() {
  $('#preset').value = state.presetKey;
  const desc = T.presets[state.presetKey][1];
  $('#presetDesc').textContent = isModified() ? `${desc} (${T.modified})` : desc;
  document.querySelectorAll('#subs .chip').forEach((b) => {
    b.textContent = subName(b.dataset.sub);
    b.setAttribute('aria-checked', String(b.dataset.sub === state.sub));
    b.tabIndex = b.dataset.sub === state.sub ? 0 : -1;
  });
  for (const sd of ALL_SLIDERS) {
    const input = $(`#sl-${sd.key}`);
    const v = sd.get(state.params);
    if (parseFloat(input.value) !== v) input.value = v;
    const lab = input.parentElement.querySelector('.lab');
    lab.children[0].textContent = sd.label();
    lab.children[1].textContent = sd.fmt(v);
    input.setAttribute('aria-valuetext', sd.fmt(v));
  }
  document.querySelectorAll('#drugs input').forEach((cb) => {
    const d = cb.dataset.drug;
    cb.checked = !!state.params.drugs[d];
    const span = cb.nextElementSibling;
    span.querySelector('.dn').textContent = T.drugs[d][0];
    span.querySelector('small').textContent = T.drugs[d][1];
  });
}

function isModified() {
  return JSON.stringify(state.params) !== JSON.stringify(presetParams(state.presetKey));
}

// ------------------------------------------------------------------ nephron diagram
const GEOM = {
  pct: { d: 'M182,52 C168,34 146,22 124,30 C102,38 106,64 126,68 C146,72 146,96 124,100 C102,104 88,88 90,68 C92,46 72,24 52,34 C34,44 40,74 56,86 C70,96 60,124 60,150 L60,228', w: 15, label: [12, 128, 'end-left'] },
  tdl: { d: 'M60,228 L64,470 C65,488 78,496 92,492', w: 6, label: [54, 330, 'end'] },
  atl: { d: 'M92,492 C104,488 108,478 108,466 L110,372', w: 6, label: [118, 440, 'start'] },
  tal: { d: 'M110,372 L114,170 C116,150 134,140 154,138 C172,136 184,112 194,96', w: 11, label: [124, 286, 'start'] },
  dct: { d: 'M196,97 C190,120 196,140 220,142 C246,144 252,122 272,124 C292,126 292,154 314,154 C336,154 340,130 354,138', w: 11, label: [270, 178, 'middle'] },
  cnt: { d: 'M354,138 C366,158 388,164 406,152 C422,142 432,126 452,124', w: 10, label: [400, 186, 'middle'] },
  ccd: { d: 'M460,124 L460,206', w: 13, label: [474, 170, 'start'] },
  mcd: { d: 'M460,206 L460,488', w: 15, label: [474, 330, 'start'] },
};
const ZONES = { cortexEnd: 206, outerEnd: 362, innerEnd: 500 };
const nodes = { tubes: {}, hits: {}, halos: {}, labels: {}, paths: {}, len: {} };

function svgEl(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function buildNephron() {
  const svg = $('#nephron');
  svg.innerHTML = '';
  const defs = svgEl('defs', {}, svg);
  const grad = svgEl('linearGradient', { id: 'medGrad', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgEl('stop', { offset: '0', 'stop-color': 'var(--med1)' }, grad);
  svgEl('stop', { offset: '0.45', 'stop-color': 'var(--med2)' }, grad);
  svgEl('stop', { offset: '1', 'stop-color': 'var(--med3)' }, grad);
  const mk = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrowhead' }, mk);

  // zones
  svgEl('rect', { x: 0, y: 0, width: 600, height: ZONES.cortexEnd, fill: 'var(--med1)' }, svg);
  nodes.medulla = svgEl('rect', { x: 0, y: ZONES.cortexEnd, width: 600, height: ZONES.innerEnd - ZONES.cortexEnd, fill: 'url(#medGrad)' }, svg);
  svgEl('line', { x1: 0, x2: 600, y1: ZONES.cortexEnd, y2: ZONES.cortexEnd, stroke: 'var(--line)', 'stroke-dasharray': '5 4' }, svg);
  svgEl('line', { x1: 0, x2: 600, y1: ZONES.outerEnd, y2: ZONES.outerEnd, stroke: 'var(--line)', 'stroke-dasharray': '5 4' }, svg);
  nodes.zoneText = {};
  const zt = (key, y) => {
    // right-hand column, clear of the collecting duct (x = 460)
    const a = svgEl('text', { x: 594, y, 'text-anchor': 'end', class: 'zone-label' }, svg);
    const b = svgEl('text', { x: 594, y: y + 14, 'text-anchor': 'end', class: 'zone-osm' }, svg);
    nodes.zoneText[key] = [a, b];
  };
  zt('cortex', 18); zt('outer', ZONES.cortexEnd + 18); zt('inner', ZONES.outerEnd + 18);

  // glomerulus
  const g = svgEl('g', {}, svg);
  svgEl('path', { d: 'M209,90 L224,114 M216,88 L238,108', class: 'vessel' }, g);
  svgEl('circle', { cx: 205, cy: 62, r: 28, class: 'glom-cap' }, g);
  svgEl('path', { d: 'M192,62 c0,-12 10,-12 10,0 c0,12 10,12 10,0 c0,-12 10,-12 10,0 M196,72 c4,-9 12,-9 14,0 c2,9 10,9 12,0 M196,52 c4,-8 12,-8 14,0 c2,8 10,8 12,0', class: 'glom-tuft' }, g);
  nodes.glomLabel = svgEl('text', { x: 240, y: 40, class: 'svg-small' }, svg);
  nodes.mdLabel = svgEl('text', { x: 134, y: 196, class: 'svg-small' }, svg);
  svgEl('line', { x1: 168, y1: 186, x2: 190, y2: 104, stroke: 'var(--conn)', 'stroke-width': 0.8 }, svg);

  // collecting duct above the CNT junction + other nephrons
  svgEl('path', { d: 'M460,20 L460,124', class: 'seg-tube seg-base', 'stroke-width': 13 }, svg);
  svgEl('path', { d: 'M500,44 C488,48 476,52 466,58 M500,96 C488,100 476,104 466,108', fill: 'none', stroke: 'var(--tube)', 'stroke-width': 7, 'stroke-linecap': 'round' }, svg);
  nodes.otherLabel = svgEl('text', { x: 506, y: 76, class: 'svg-small' }, svg);

  // tubes
  for (const s of SEGMENTS) {
    const geo = GEOM[s];
    nodes.halos[s] = svgEl('path', { d: geo.d, class: 'seg-halo', 'stroke-width': geo.w + 9 }, svg);
    svgEl('path', { d: geo.d, class: 'seg-tube seg-base', 'stroke-width': geo.w + 4 }, svg);
    nodes.tubes[s] = svgEl('path', { d: geo.d, class: 'seg-tube', 'stroke-width': geo.w }, svg);
  }
  // urine
  svgEl('path', { d: 'M460,496 L460,526', class: 'urine-arrow', 'marker-end': 'url(#arrow)' }, svg);
  nodes.urineLabel = svgEl('text', { x: 472, y: 522, class: 'svg-small' }, svg);

  // particles layer
  nodes.particles = svgEl('g', { 'aria-hidden': 'true' }, svg);

  // labels and hit areas on top
  for (const s of SEGMENTS) {
    const geo = GEOM[s];
    const [x, y, anchor] = geo.label;
    const tx = svgEl('text', { x, y, 'text-anchor': anchor === 'end-left' ? 'start' : anchor, class: 'seg-label' }, svg);
    const a = svgEl('tspan', { class: 'abbr', x, dy: 0 }, tx);
    const v = svgEl('tspan', { class: 'pv', x, dy: 14 }, tx);
    nodes.labels[s] = { a, v, tx };
    const hit = svgEl('path', { d: geo.d, class: 'seg-hit', tabindex: 0, role: 'button' }, svg);
    hit.addEventListener('click', () => selectSeg(s));
    hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSeg(s); } });
    nodes.hits[s] = hit;
    nodes.paths[s] = nodes.tubes[s];
  }
  for (const s of SEGMENTS) nodes.len[s] = nodes.paths[s].getTotalLength();
}

function rampVar(frac) {
  if (frac < -0.0005) {
    const a = -frac;
    return a < 0.02 ? 'var(--secA)' : a < 0.08 ? 'var(--secB)' : 'var(--secC)';
  }
  if (frac < 0.001) return 'var(--seq0)';
  if (frac < 0.01) return 'var(--seq1)';
  if (frac < 0.05) return 'var(--seq2)';
  if (frac < 0.15) return 'var(--seq3)';
  if (frac < 0.4) return 'var(--seq4)';
  return 'var(--seq5)';
}

function renderNephron() {
  const fr = segmentFractions(R, state.sub);
  for (const { seg, frac } of fr) {
    nodes.tubes[seg].setAttribute('stroke', rampVar(frac));
    const L = nodes.labels[seg];
    L.a.textContent = segAbbr(seg);
    L.v.textContent = Math.abs(frac) < 0.0005 ? '0 %' : pct(frac);
    L.v.setAttribute('class', `pv${frac < -0.0005 ? ' neg' : ''}`);
    nodes.halos[seg].classList.toggle('on', seg === state.seg);
    nodes.hits[seg].setAttribute('aria-label', `${segName(seg)}: ${pct(frac)} ${T.ofFiltered}`);
    nodes.hits[seg].setAttribute('aria-pressed', String(seg === state.seg));
  }
  const imax = R.Imax;
  nodes.medulla.setAttribute('opacity', String(0.25 + 0.75 * Math.min(1, Math.max(0, (imax - 300) / 900))));
  nodes.zoneText.cortex[0].textContent = T.cortex;
  nodes.zoneText.cortex[1].textContent = '~300 mOsm/kg';
  nodes.zoneText.outer[0].textContent = T.outerMed;
  nodes.zoneText.outer[1].textContent = `~${nf(Math.round((300 + (imax - 300) * 0.45) / 10) * 10)} mOsm/kg`;
  nodes.zoneText.inner[0].textContent = T.innerMed;
  nodes.zoneText.inner[1].textContent = `~${nf(Math.round(imax / 10) * 10)} mOsm/kg`;
  nodes.glomLabel.textContent = T.bowman;
  nodes.mdLabel.textContent = T.maculaDensa;
  nodes.otherLabel.textContent = T.otherNephrons;
  nodes.urineLabel.textContent = `${T.urine}: ${amount(state.sub, R.excreted[state.sub])}${T.perDay}`;
  $('#nephron').setAttribute('aria-label', T.nephronAria);

  // legend
  const steps = [
    ['var(--seq0)', '0'], ['var(--seq1)', '<1'], ['var(--seq2)', '1–5'], ['var(--seq3)', '5–15'],
    ['var(--seq4)', '15–40'], ['var(--seq5)', '>40'], ['var(--secB)', T.legendSecretion],
  ];
  $('#legend').innerHTML = `<b>${T.legendTitle}:</b>${steps.map(([c, l]) => `<span><i class="sw" style="background:${c}"></i>${l}</span>`).join('')}`;
  $('#anim').textContent = state.animate ? T.pause : T.play;
  const [pl, a, b, c] = T.legendParticles;
  $('#pLegend').innerHTML = `${pl}: <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.2" class="p-lumen"/></svg> ${a} · <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.2" class="p-sec"/></svg> ${b} · ${c}`;
}

// ------------------------------------------------------------------ particles
const PS = { list: [], last: 0, acc: 0, sacc: {}, raf: 0 };
const SPEED = 110;  // px/s
const SPAWN = 10;   // particles/s at filtration
const MAXP = 320;

function fateFor(seg) {
  const row = R.seg[state.sub][SEGMENTS.indexOf(seg)];
  if (!row || row.reabsorbed <= 0 || row.delivered <= 0) return null;
  const p = row.reabsorbed / row.delivered;
  return Math.random() < p ? nodes.len[seg] * (0.08 + 0.84 * Math.random()) : null;
}

function spawn(segIdx, tpos, kind) {
  if (PS.list.length >= MAXP) return;
  const seg = SEGMENTS[segIdx];
  const c = svgEl('circle', { r: 2.6, class: kind === 'sec' ? 'p-sec' : 'p-lumen' }, nodes.particles);
  const p = { segIdx, t: tpos, state: 'lumen', c, age: 0, reabsAt: null, ox: 0, oy: 0, nx: 0, ny: 0, kind };
  if (kind !== 'sec') p.reabsAt = fateFor(seg);
  else p.reabsAt = null;
  if (p.reabsAt !== null && p.reabsAt < p.t) p.reabsAt = null;
  PS.list.push(p);
}

function step(ts) {
  if (!state.animate) { PS.raf = 0; return; }
  const dt = PS.last ? Math.min(0.05, (ts - PS.last) / 1000) : 0;
  PS.last = ts;
  PS.acc += SPAWN * dt;
  while (PS.acc >= 1) { PS.acc -= 1; spawn(0, 0, 'lumen'); }
  // secretion sources
  const F0 = R.filtered[state.sub];
  R.seg[state.sub].forEach((row, i) => {
    if (row.reabsorbed >= 0 || F0 <= 0) return;
    const rate = SPAWN * Math.min(1.5, -row.reabsorbed / F0) * 1.6;
    PS.sacc[i] = (PS.sacc[i] || 0) + rate * dt;
    while (PS.sacc[i] >= 1) {
      PS.sacc[i] -= 1;
      const seg = SEGMENTS[i];
      const tp = nodes.len[seg] * (0.1 + 0.8 * Math.random());
      spawn(i, tp, 'sec');
      const p = PS.list[PS.list.length - 1];
      if (p) { p.state = 'in'; setOrigin(p, seg, tp); }
    }
  });

  const keep = [];
  for (const p of PS.list) {
    const seg = SEGMENTS[p.segIdx];
    if (p.state === 'lumen') {
      p.t += SPEED * dt * (seg === 'pct' ? 1.4 : 1);
      if (p.reabsAt !== null && p.t >= p.reabsAt) {
        p.state = 'out'; p.age = 0; setOrigin(p, seg, p.reabsAt);
        p.c.setAttribute('class', 'p-out');
      } else if (p.t >= nodes.len[seg]) {
        p.t -= nodes.len[seg];
        p.segIdx += 1;
        if (p.segIdx >= SEGMENTS.length) {
          p.state = 'urine'; p.age = 0;
          const pt = nodes.paths.mcd.getPointAtLength(nodes.len.mcd);
          p.ox = pt.x; p.oy = pt.y;
        } else {
          p.reabsAt = p.kind === 'sec' ? fateFor(SEGMENTS[p.segIdx]) : fateFor(SEGMENTS[p.segIdx]);
        }
      }
      if (p.state === 'lumen') {
        const pt = nodes.paths[SEGMENTS[p.segIdx]].getPointAtLength(Math.min(p.t, nodes.len[SEGMENTS[p.segIdx]]));
        p.c.setAttribute('cx', pt.x.toFixed(1)); p.c.setAttribute('cy', pt.y.toFixed(1));
      }
    }
    if (p.state === 'out') {
      p.age += dt;
      const d = 6 + p.age * 34;
      p.c.setAttribute('cx', (p.ox + p.nx * d).toFixed(1));
      p.c.setAttribute('cy', (p.oy + p.ny * d).toFixed(1));
      p.c.setAttribute('opacity', String(Math.max(0, 1 - p.age / 0.75)));
      if (p.age > 0.75) { p.c.remove(); continue; }
    } else if (p.state === 'in') {
      p.age += dt;
      const d = Math.max(0, 22 - p.age * 40);
      p.c.setAttribute('cx', (p.ox + p.nx * d).toFixed(1));
      p.c.setAttribute('cy', (p.oy + p.ny * d).toFixed(1));
      if (d <= 0) { p.state = 'lumen'; p.reabsAt = null; }
    } else if (p.state === 'urine') {
      p.age += dt;
      p.c.setAttribute('cx', p.ox.toFixed(1));
      p.c.setAttribute('cy', (p.oy + p.age * 40).toFixed(1));
      p.c.setAttribute('opacity', String(Math.max(0, 1 - p.age / 0.8)));
      if (p.age > 0.8) { p.c.remove(); continue; }
    }
    keep.push(p);
  }
  PS.list = keep;
  PS.raf = requestAnimationFrame(step);
}

function setOrigin(p, seg, tpos) {
  const path = nodes.paths[seg];
  const L = nodes.len[seg];
  const a = path.getPointAtLength(Math.max(0, Math.min(L, tpos)));
  const b = path.getPointAtLength(Math.max(0, Math.min(L, tpos + 1)));
  let nx = -(b.y - a.y); let ny = b.x - a.x;
  const m = Math.hypot(nx, ny) || 1;
  nx /= m; ny /= m;
  if (Math.random() < 0.5) { nx = -nx; ny = -ny; }
  p.ox = a.x; p.oy = a.y; p.nx = nx; p.ny = ny;
}

function resetParticles() {
  for (const p of PS.list) p.c.remove();
  PS.list = []; PS.acc = 0; PS.sacc = {};
}

function startAnim() {
  if (state.animate && !PS.raf) { PS.last = 0; PS.raf = requestAnimationFrame(step); }
}

// ------------------------------------------------------------------ segment panel
function renderSegPanel() {
  const s = state.seg;
  const info = T.segInfo[s];
  const i = SEGMENTS.indexOf(s);
  const rows = SUBSTANCES.map((sub) => ({ sub, frac: R.filtered[sub] > 0 ? R.seg[sub][i].reabsorbed / R.filtered[sub] : 0 }))
    .filter((r) => Math.abs(r.frac) >= 0.0005);
  const bars = rows.map((r) => {
    const w = Math.min(100, Math.abs(r.frac) * 100);
    const cls = r.sub === state.sub ? 'selrow' : '';
    return `<span class="${cls}">${subName(r.sub)}</span><span class="bg"><span class="fg${r.frac < 0 ? ' neg' : ''}" style="width:${w}%"></span></span><span class="num ${cls}">${pct(r.frac)}</span>`;
  }).join('');
  const lines = Object.entries(info.t);
  lines.sort((a, b) => (b[0] === state.sub) - (a[0] === state.sub));
  const has = lines.some(([k]) => k === state.sub);
  const tl = lines.map(([k, txt]) => `<li class="${k === state.sub ? 'sel' : ''}">${txt}</li>`).join('')
    + (has ? '' : `<li class="muted">${subName(state.sub)}: ${T.noTransport}</li>`);
  $('#segPanel').innerHTML = `
    <h3>${segName(s)} (${segAbbr(s)})</h3>
    <p class="sum">${info.summary}</p>
    <dl>
      <dt>${T.where}</dt><dd>${info.where}</dd>
      <dt>${T.here}</dt><dd><div class="herebars">${bars}</div></dd>
      <dt>${T.transport}</dt><dd><ul class="tlist">${tl}</ul>${info.extra ? `<p class="muted small">${info.extra}</p>` : ''}</dd>
      <dt>${T.regulation}</dt><dd>${info.reg}</dd>
      <dt>${T.drugsInSeg}</dt><dd>${info.drugs}</dd>
      <dt>${T.clinical}</dt><dd>${info.clin}</dd>
    </dl>
    <p class="muted small">${T.clickHint}</p>`;
}

// ------------------------------------------------------------------ charts
const different = () => JSON.stringify(state.params) !== JSON.stringify(presetParams('normal'));

function tableHTML(head, rows) {
  return `<table aria-label="${T.tableAria}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td${typeof c === 'object' ? ` class="${c.cls}"` : ''}>${typeof c === 'object' ? c.v : c}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

function renderCharts() {
  const sub = state.sub;
  const cmp = different();
  const sn = subName(sub);

  // 1. remaining profile
  const cats = [T.filtered, ...SEGMENTS.map(segAbbr)];
  const now = remainingProfile(R, sub).map((v) => v * 100);
  const norm = remainingProfile(NORMAL, sub).map((v) => v * 100);
  $('#remTitle').textContent = T.chartRemaining(sn);
  const series = [{ name: T.seriesNow, values: now, cls: 'now' }];
  if (cmp) series.push({ name: T.seriesNormal, values: norm, cls: 'normal', dashed: true });
  const fmtAxis = (v) => (state.logScale ? `${nf(v, v < 1 ? (v < 0.1 ? 2 : 1) : 0)} %` : `${nf(v)} %`);
  lineChart($('#chartRemaining'), {
    categories: cats, series, log: state.logScale, yMin: state.logScale ? undefined : 0,
    yMax: state.logScale ? undefined : Math.max(100, ...now, ...(cmp ? norm : [])) * (Math.max(...now) > 100 ? 1.08 : 1),
    yFmt: fmtAxis, height: 250, endLabel: `${pct(now[now.length - 1] / 100)}`,
    ariaLabel: T.chartRemaining(sn),
    tip: (i) => `<b>${i === 0 ? T.filtered : segName(SEGMENTS[i - 1])}</b>
      <div class="row"><span><i class="sw"></i>${T.seriesNow}</span><span>${pct(now[i] / 100)}</span></div>
      ${cmp ? `<div class="row"><span><i class="sw dash"></i>${T.seriesNormal}</span><span>${pct(norm[i] / 100)}</span></div>` : ''}`,
  });
  $('#remLegend').innerHTML = `<span><i class="sw"></i>${T.seriesNow}</span>${cmp ? `<span><i class="sw dash"></i>${T.seriesNormal}</span>` : ''}`;
  $('#tblRemaining').innerHTML = tableHTML([T.colSegment, T.colRemaining, T.colNormal],
    cats.map((c, i) => [c, pct(now[i] / 100), pct(norm[i] / 100)]));

  // 2. per-segment fractions
  const fNow = segmentFractions(R, sub).map((x) => x.frac);
  const fNorm = segmentFractions(NORMAL, sub).map((x) => x.frac);
  $('#segTitle').textContent = T.chartSegments(sn);
  barChart($('#chartSegments'), {
    categories: SEGMENTS.map(segAbbr), values: fNow, ghost: cmp ? fNorm : null, height: 230,
    yFmt: (v) => `${nf(v * 100)} %`, labelFmt: (v) => pct(v), ariaLabel: T.chartSegments(sn),
    tip: (i) => `<b>${segName(SEGMENTS[i])}</b>
      <div class="row"><span><i class="sw ${fNow[i] < 0 ? 'sec' : ''}"></i>${T.seriesNow}</span><span>${pct(fNow[i])} ${fNow[i] < 0 ? T.secretedTip : T.reabsorbedTip}</span></div>
      ${cmp ? `<div class="row"><span><i class="sw dash"></i>${T.seriesNormal}</span><span>${pct(fNorm[i])}</span></div>` : ''}
      <div class="row muted"><span>${amount(sub, R.seg[sub][i].reabsorbed)}${T.perDay}</span></div>`,
  });
  $('#segLegend').innerHTML = `<span><i class="sw" style="height:8px"></i>${T.reabsorbedTip}</span><span><i class="sw sec"></i>${T.legendSecretion}</span>${cmp ? `<span><i class="sw dash"></i>${T.seriesNormal}</span>` : ''}`;
  $('#tblSegments').innerHTML = tableHTML([T.colSegment, T.colReabsorbed, `${T.colReabsorbed} (${T.units[UNITS[sub] === 'mmol' && sub === 'glucose' ? 'g' : UNITS[sub]]}${T.perDay})`, T.colNormal],
    SEGMENTS.map((s, i) => [segName(s), fNow[i] < 0 ? { v: pct(fNow[i]), cls: 'neg' } : pct(fNow[i]), amount(sub, R.seg[sub][i].reabsorbed), pct(fNorm[i])]));

  // 3. osmolality
  const oCats = R.osmProfile.map((o) => (o.point === 'bowman' ? 'Bowman' : segAbbr(o.point)));
  const oNow = R.osmProfile.map((o) => o.value);
  const oNorm = NORMAL.osmProfile.map((o) => o.value);
  const oSeries = [{ name: T.seriesNow, values: oNow, cls: 'now' }];
  if (cmp) oSeries.push({ name: T.seriesNormal, values: oNorm, cls: 'normal', dashed: true });
  lineChart($('#chartOsm'), {
    categories: oCats, series: oSeries, yMin: 0, yMax: 1300, height: 230,
    yFmt: (v) => nf(v), ariaLabel: T.chartOsm, endLabel: `${nf(oNow[oNow.length - 1])} mOsm/kg`,
    tip: (i) => `<b>${i === 0 ? 'Bowman' : segName(R.osmProfile[i].point)}</b>
      <div class="row"><span><i class="sw"></i>${T.seriesNow}</span><span>${nf(oNow[i])}</span></div>
      ${cmp ? `<div class="row"><span><i class="sw dash"></i>${T.seriesNormal}</span><span>${nf(oNorm[i])}</span></div>` : ''}`,
  });
  $('#osmLegend').innerHTML = `<span><i class="sw"></i>${T.seriesNow}</span>${cmp ? `<span><i class="sw dash"></i>${T.seriesNormal}</span>` : ''}`;
  $('#tblOsm').innerHTML = tableHTML([T.point, T.colOsm, T.colNormal], oCats.map((c, i) => [c, nf(oNow[i]), nf(oNorm[i])]));

  document.querySelectorAll('.tabletoggle').forEach((b) => {
    const tbl = document.getElementById(b.dataset.target);
    b.textContent = tbl.hidden ? T.showTable : T.hideTable;
    b.setAttribute('aria-expanded', String(!tbl.hidden));
  });
}

// ------------------------------------------------------------------ outputs
function flag(v, [lo, hi]) {
  if (v > hi) return `<span class="flag hi">↑ ${T.high}</span>`;
  if (v < lo) return `<span class="flag lo">↓ ${T.low}</span>`;
  return `<span class="flag ok">${T.ok}</span>`;
}

function renderUrine() {
  const u = R.urine;
  const rows = [
    ['na', 'feNa'], ['k', 'feK'], ['ca', 'feCa'], ['mg', 'feMg'], ['pi', 'fePi'], ['hco3', [0, 0.01]], ['urea', 'feUrea'],
  ];
  const feRows = rows.map(([s, ref]) => {
    const r = typeof ref === 'string' ? REFERENCE[ref] : ref;
    return `<span>${T.fe} ${subName(s)}</span><span class="num">${pct(R.fe[s])}</span>${flag(R.fe[s], r)}`;
  }).join('');
  const sel = state.sub;
  $('#urine').innerHTML = `
    <div class="grid2">
      <span>${T.volume}</span><span class="big">${nf(u.volume, u.volume < 10 ? 2 : 1)} L${T.perDay}</span>${flag(u.volume, REFERENCE.volume)}
      <span class="muted small">${T.flow}</span><span class="num muted small">${nf(u.flow, 2)} mL/min</span><span></span>
      <span>${T.osm}</span><span class="big">${nf(u.osm)}</span><span class="muted small">mOsm/kg</span>
      <span class="sep"></span>
      ${feRows}
      <span>${T.glycosuria}</span><span class="num">${nf(u.glucoseG, u.glucoseG < 10 ? 1 : 0)} g${T.perDay}</span>${flag(u.glucoseG, [0, 0.25])}
    </div>
    <div class="selline"><b>${T.excretedSel(subName(sel))}:</b> ${amount(sel, R.excreted[sel])}${T.perDay} · ${T.fe} ${pct(R.fe[sel])}</div>`;
}

function explainData() {
  const fr = segmentFractions(R, state.sub).filter((x) => Math.abs(x.frac) >= 0.005);
  const parts = fr.map((x) => `${segAbbr(x.seg)} ${pct(x.frac)}${x.frac < 0 ? ` (${T.legendSecretion})` : ''}`).join(', ');
  return {
    gfr: state.params.gfr, gfrL: R.gfrLday, subName: subName(state.sub),
    filteredTxt: amount(state.sub, R.filtered[state.sub]), fe: R.fe,
    glcG: R.urine.glucoseG, b2m: R.excreted.b2m, v: R.urine.volume, uosm: R.urine.osm, imax: R.Imax,
    caExcr: R.excreted.ca, sglt1G: (R.glucoseSplit.sglt1 * GLUCOSE_MG_PER_MMOL) / 1000, piP: state.params.plasma.pi,
    parts, feTxt: pct(R.fe[state.sub]), excrTxt: amount(state.sub, R.excreted[state.sub]),
  };
}

export function activeMechanisms(params) {
  const p = mergeParams(params);
  const { act, mrBlock } = effectiveActivity(p);
  const keys = [];
  if (p.act.pct < 0.9) keys.push('fanconi');
  if (act.sglt2 < 0.5) keys.push('sglt2i');
  if (act.ca < 0.5) keys.push('acetazolamide');
  if (act.nkcc2 < 0.5) keys.push('nkcc2');
  if (act.ncc < 0.5) keys.push('ncc');
  if (act.enac < 0.5) keys.push('enacBlock');
  if (mrBlock) keys.push('spironolactone');
  if (act.enac > 1.5) keys.push('enacGain');
  else if (!mrBlock && p.aldo >= 0.8) keys.push('aldoHigh');
  else if (!mrBlock && p.aldo <= 0.25) keys.push('aldoLow');
  if (act.aqp2 < 0.5) keys.push('aqp2');
  else if (p.adh <= 0.2) keys.push('adhLow');
  else if (p.adh >= 0.85) keys.push('adhHigh');
  if (p.pth >= 0.8) keys.push('pthHigh');
  else if (p.pth <= 0.2 && p.plasma.ca < 2.65) keys.push('pthLow');
  if (p.plasma.ca >= 2.65) keys.push('casr');
  if (p.plasma.k <= 3.4) keys.push('kLow');
  else if (p.plasma.k >= 5.5) keys.push('kHigh');
  if (Math.abs(p.gfr - 125) >= 10) keys.push('gfr');
  if (p.plasma.pi >= 1.6) keys.push('pi');
  return keys;
}

let lastLit = new Set();
function renderExplain() {
  const d = explainData();
  const keys = activeMechanisms(state.params);
  if (!keys.includes('sglt2i') && !keys.includes('fanconi') && R.urine.glucoseG > 1) keys.unshift('glucoseTm');
  const items = [`<li class="on base">${T.expl.filtration(d, F)}</li>`];
  if (!keys.length) items.push(`<li class="on base">${T.expl.normal()}</li>`);
  const nowLit = new Set(keys);
  for (const k of keys) {
    const fresh = !lastLit.has(k);
    items.push(`<li class="on mech${fresh ? ' fresh' : ''}" data-mech="${k}">${T.expl[k](d, F)}</li>`);
  }
  lastLit = nowLit;
  items.push(`<li class="on base">${T.expl.substance(d, F)}</li>`);
  $('#explain').innerHTML = items.join('');
}

// log entries keep raw values; text is produced at render time (language-safe)
function addLog(entry, before) {
  const after = R;
  state.log.unshift({ ...entry, before: snap(before), after: snap(after) });
  if (state.log.length > 40) state.log.pop();
  renderLog();
}
const snap = (r) => ({ na: r.fe.na, k: r.fe.k, v: r.urine.volume, osm: r.urine.osm });

function renderLog() {
  const ol = $('#log');
  if (!state.log.length) { ol.innerHTML = `<li class="muted" style="list-style:none">${T.logEmpty}</li>`; return; }
  ol.innerHTML = state.log.map((e) => {
    let head;
    if (e.kind === 'preset') head = T.log.preset({ name: T.presets[e.key][0] });
    else if (e.kind === 'drugOn' || e.kind === 'drugOff') head = T.log[e.kind]({ name: T.drugs[e.drug][0] });
    else if (e.kind === 'reset') head = T.log.reset();
    else {
      const sd = ALL_SLIDERS.find((x) => x.key === e.key);
      head = T.log.slider({ label: sd.label(), from: sd.fmt(e.from), to: sd.fmt(e.to) });
    }
    const arrow = (a, b, f) => (f(a) === f(b) ? f(b) : `${f(a)} → ${f(b)}`);
    const eff = T.log.effect({
      na: arrow(e.before.na, e.after.na, pct), k: arrow(e.before.k, e.after.k, pct),
      v: arrow(e.before.v, e.after.v, (x) => nf(x, x < 10 ? 2 : 1)), osm: arrow(e.before.osm, e.after.osm, (x) => nf(x)),
    });
    return `<li>${head}<span class="eff">${eff}</span></li>`;
  }).join('');
}

function renderReference() {
  const head = ['', ...SEGMENTS.map(segAbbr), T.excreted];
  const rows = SUBSTANCES.map((s) => {
    const fr = segmentFractions(NORMAL, s).map((x) => x.frac);
    return [subName(s), ...fr.map((f) => {
      const v = Math.abs(f) < 0.0005 ? '–' : nf(f * 100, Math.abs(f) < 0.1 ? 1 : 0);
      return f < -0.0005 ? { v, cls: 'neg' } : (f >= 0.15 ? { v, cls: 'big' } : v);
    }), nf(NORMAL.fe[s] * 100, NORMAL.fe[s] < 0.1 ? 1 : 0)];
  });
  $('#reference').innerHTML = tableHTML(head, rows).replace('<table', '<table class="ref"');
}

// ------------------------------------------------------------------ i18n + URL
function applyStaticText() {
  document.documentElement.lang = state.lang;
  document.title = T.docTitle;
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = T[n.dataset.i18n]; });
  document.querySelectorAll('[data-i18n-aria]').forEach((n) => n.setAttribute('aria-label', T[n.dataset.i18nAria]));
  document.querySelectorAll('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
  document.querySelectorAll('#preset option').forEach((o) => { o.textContent = T.presets[o.value][0]; });
}

function urlFor(full = false) {
  const u = new URL(location.href);
  u.search = '';
  if (!isModified() && state.presetKey !== 'normal') u.searchParams.set('preset', state.presetKey);
  u.searchParams.set('lang', state.lang);
  if (state.sub !== 'na') u.searchParams.set('sub', state.sub);
  if (state.seg !== 'pct') u.searchParams.set('seg', state.seg);
  return full ? u.toString() : `${u.pathname}${u.search}`;
}

function syncURL() {
  try { history.replaceState(null, '', urlFor()); } catch { /* file:// */ }
}

// ------------------------------------------------------------------ actions
function render() {
  R = simulate(state.params);
  syncControls();
  renderNephron();
  renderSegPanel();
  renderCharts();
  renderUrine();
  renderExplain();
  syncURL();
}

function renderAll() {
  applyStaticText();
  render();
  renderLog();
  renderReference();
}

function setPreset(key, log = true) {
  if (!PRESET_KEYS.includes(key)) return;
  const before = R;
  state.presetKey = key;
  state.params = presetParams(key);
  render();
  if (log) addLog({ kind: 'preset', key }, before);
}

function setSub(s) {
  if (!SUBSTANCES.includes(s)) return;
  state.sub = s;
  resetParticles();
  render();
}

function selectSeg(s) {
  if (!SEGMENTS.includes(s)) return;
  state.seg = s;
  render();
}

function setLang(l) {
  if (!LANGS.includes(l)) return;
  state.lang = l;
  T = t(l);
  try { localStorage.setItem('nephron-lang', l); } catch { /* ignore */ }
  renderAll();
}

function wire() {
  $('#preset').addEventListener('change', (e) => setPreset(e.target.value));
  $('#reset').addEventListener('click', () => {
    const before = R;
    state.presetKey = 'normal';
    state.params = presetParams('normal');
    render();
    addLog({ kind: 'reset' }, before);
  });
  $('#copyLink').addEventListener('click', async () => {
    const link = urlFor(true);
    try { await navigator.clipboard.writeText(link); $('#copyMsg').textContent = T.copied; } catch { $('#copyMsg').textContent = link; }
    setTimeout(() => { $('#copyMsg').textContent = ''; }, 2500);
  });
  $('#clearLog').addEventListener('click', () => { state.log = []; renderLog(); });
  $('#logScale').addEventListener('change', (e) => { state.logScale = e.target.checked; renderCharts(); });
  $('#anim').addEventListener('click', () => {
    state.animate = !state.animate;
    if (!state.animate) resetParticles(); else startAnim();
    $('#anim').textContent = state.animate ? T.pause : T.play;
  });
  document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  document.querySelectorAll('.tabletoggle').forEach((b) => b.addEventListener('click', () => {
    const tbl = document.getElementById(b.dataset.target);
    tbl.hidden = !tbl.hidden;
    b.textContent = tbl.hidden ? T.showTable : T.hideTable;
    b.setAttribute('aria-expanded', String(!tbl.hidden));
  }));
  // arrow-key navigation in the substance radiogroup
  $('#subs').addEventListener('keydown', (e) => {
    const i = SUBSTANCES.indexOf(state.sub);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setSub(SUBSTANCES[(i + 1) % SUBSTANCES.length]); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setSub(SUBSTANCES[(i - 1 + SUBSTANCES.length) % SUBSTANCES.length]); }
    if (e.key.startsWith('Arrow')) document.querySelector(`#subs [data-sub="${state.sub}"]`)?.focus();
  });
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderCharts, 120); });
}

// ------------------------------------------------------------------ boot
buildControls();
buildNephron();
wire();
renderAll();
startAnim();

// hook for automated checks
window.__sim = {
  get state() { return JSON.parse(JSON.stringify({ ...state, log: undefined })); },
  get result() { return R; },
  simulate, presetParams, PRESET_KEYS, SEGMENTS, SUBSTANCES,
  setPreset: (k) => setPreset(k, false), setLang, setSub, selectSeg, activeMechanisms,
};
