import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulate, presetParams, PRESET_KEYS, PRESETS, SEGMENTS, SUBSTANCES, DEFAULTS,
  segmentFractions, remainingProfile, smoothMin, mergeParams, effectiveActivity,
} from '../src/model.js';

const base = simulate();
const run = (k) => simulate(presetParams(k));
const finite = (x) => Number.isFinite(x) && !Number.isNaN(x);

test('healthy baseline matches textbook values', () => {
  assert.ok(Math.abs(base.gfrLday - 180) < 0.1, 'GFR 125 mL/min ≈ 180 L/day');
  assert.ok(base.urine.volume > 1.0 && base.urine.volume < 2.0, `V ${base.urine.volume}`);
  assert.ok(base.urine.osm > 500 && base.urine.osm < 800, `Uosm ${base.urine.osm}`);
  assert.ok(base.fe.na > 0.003 && base.fe.na < 0.01, `FENa ${base.fe.na}`);
  assert.ok(base.fe.k > 0.08 && base.fe.k < 0.2, `FEK ${base.fe.k}`);
  assert.ok(base.fe.ca > 0.005 && base.fe.ca < 0.025);
  assert.ok(base.fe.mg > 0.02 && base.fe.mg < 0.06);
  assert.ok(base.fe.pi > 0.05 && base.fe.pi < 0.2);
  assert.ok(base.fe.urea > 0.35 && base.fe.urea < 0.6);
  assert.ok(base.fe.hco3 < 0.005);
  assert.ok(base.urine.glucoseG < 0.25, 'no glycosuria at fasting glucose');
  assert.ok(base.fe.aa < 0.02);
});

test('PCT reabsorbs ~2/3 of filtered Na and water, isosmotically', () => {
  const na = segmentFractions(base, 'na')[0].frac;
  const w = segmentFractions(base, 'water')[0].frac;
  assert.ok(Math.abs(na - 0.66) < 0.01);
  assert.ok(Math.abs(w - 0.66) < 0.01);
  const pctOsm = base.osmProfile.find((o) => o.point === 'pct').value;
  assert.ok(Math.abs(pctOsm - 300) < 15, `PCT fluid osm ${pctOsm}`);
});

test('segment roles: TAL is the main Mg site, PCT the main Pi/HCO3 site', () => {
  const mg = segmentFractions(base, 'mg');
  const top = mg.reduce((a, b) => (b.frac > a.frac ? b : a));
  assert.equal(top.seg, 'tal');
  assert.ok(segmentFractions(base, 'pi')[0].frac > 0.75);
  assert.ok(segmentFractions(base, 'hco3')[0].frac > 0.75);
  assert.ok(Math.abs(segmentFractions(base, 'na')[3].frac - 0.23) < 0.02);
});

test('water: no reabsorption in ascending limbs or DCT; TAL fluid is hypotonic', () => {
  const w = segmentFractions(base, 'water');
  for (const sg of ['atl', 'tal', 'dct']) assert.equal(w.find((x) => x.seg === sg).frac, 0);
  const tal = base.osmProfile.find((o) => o.point === 'tal').value;
  const dct = base.osmProfile.find((o) => o.point === 'dct').value;
  assert.ok(tal < 200 && dct < tal, `TAL ${tal}, DCT ${dct}`);
});

test('urea enters the thin limbs (negative) and is reabsorbed in the IMCD', () => {
  const u = segmentFractions(base, 'urea');
  assert.ok(u[1].frac < 0 && u[2].frac < 0);
  assert.ok(u[7].frac > 0.2);
});

test('K+ is secreted in DCT2/CNT/CCD', () => {
  const k = segmentFractions(base, 'k');
  for (const i of [4, 5, 6]) assert.ok(k[i].frac < 0, SEGMENTS[i]);
});

test('mass balance: filtered = Σ reabsorbed + excreted for every substance', () => {
  for (const k of ['normal', ...PRESET_KEYS]) {
    const r = run(k);
    for (const s of SUBSTANCES) {
      const sum = r.seg[s].reduce((a, x) => a + x.reabsorbed, 0) + r.excreted[s];
      assert.ok(Math.abs(sum - r.filtered[s]) < 1e-6 * Math.max(1, r.filtered[s]), `${k}/${s}`);
    }
  }
});

test('never negative or NaN, including extreme inputs', () => {
  const extremes = [
    {}, { gfr: 5 }, { gfr: 200 }, { adh: 0 }, { adh: 1 }, { aldo: 0 }, { aldo: 1 },
    { pth: 0 }, { pth: 1 }, { plasma: { glucose: 800 } }, { plasma: { k: 2 } }, { plasma: { k: 8 } },
    { plasma: { ca: 1.6 } }, { plasma: { ca: 4 } }, { plasma: { pi: 3 } },
    { act: { pct: 0 } }, { act: { nkcc2: 0, ncc: 0, enac: 0 } }, { act: { enac: 6 } },
    { drugs: Object.fromEntries(Object.keys(DEFAULTS.drugs).map((d) => [d, true])) },
  ];
  for (const e of extremes) {
    const r = simulate(e);
    for (const s of SUBSTANCES) {
      assert.ok(finite(r.excreted[s]) && r.excreted[s] >= -1e-9, `${JSON.stringify(e)} ${s}`);
      for (const row of r.seg[s]) {
        assert.ok(finite(row.reabsorbed) && row.delivered >= -1e-9 && row.after >= -1e-9,
          `${JSON.stringify(e)} ${s} ${row.seg}`);
      }
    }
    assert.ok(finite(r.urine.volume) && r.urine.volume > 0);
    assert.ok(finite(r.urine.osm) && r.urine.osm > 0);
    for (const o of r.osmProfile) assert.ok(finite(o.value) && o.value > 0);
  }
});

test('urine osmolality stays within 50–1200 mOsm/kg for physiological ADH range', () => {
  for (const adh of [0, 0.25, 0.5, 0.75, 1]) {
    const r = simulate({ adh });
    assert.ok(r.urine.osm >= 45 && r.urine.osm <= 1205, `adh ${adh}: ${r.urine.osm}`);
  }
});

test('ADH: monotonic — more ADH, less urine, higher Uosm', () => {
  let prevV = Infinity; let prevO = 0;
  for (const adh of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const r = simulate({ adh });
    assert.ok(r.urine.volume < prevV && r.urine.osm > prevO);
    prevV = r.urine.volume; prevO = r.urine.osm;
  }
});

test('glucose: threshold ~180–200 mg/dL and rising glycosuria above', () => {
  const g = (mg) => simulate({ plasma: { glucose: mg } }).urine.glucoseG;
  assert.ok(g(90) < 0.25);
  assert.ok(g(160) < 2);
  assert.ok(g(220) > 3);
  assert.ok(g(300) > 40 && g(300) < 150);
  assert.ok(g(400) > g(300));
});

test('remaining profile starts at 1 and is consistent with fractions', () => {
  const prof = remainingProfile(base, 'na');
  assert.equal(prof.length, SEGMENTS.length + 1);
  assert.equal(prof[0], 1);
  assert.ok(Math.abs(prof.at(-1) - base.fe.na) < 1e-12);
});

test('smoothMin behaves like a soft minimum', () => {
  assert.ok(smoothMin(1, 100) > 0.99 && smoothMin(1, 100) <= 1);
  assert.ok(smoothMin(5, 5) < 5);
  assert.equal(smoothMin(0, 5), 0);
});

// ---- Presets: expected behaviour ----
test('dehydration (max ADH): concentrated, low-volume urine', () => {
  const r = run('dehydration');
  assert.ok(r.urine.osm > 1100 && r.urine.volume < 0.6);
});

test('central and nephrogenic DI: large dilute urine', () => {
  for (const k of ['centralDI', 'nephrogenicDI']) {
    const r = run(k);
    assert.ok(r.urine.volume > 5 && r.urine.osm < 150, k);
  }
});

test('furosemide/Bartter: big natriuresis, kaliuresis, calciuria, magnesiuria, loss of concentrating ability', () => {
  for (const k of ['furosemide', 'bartter']) {
    const r = run(k);
    assert.ok(r.fe.na > 0.10 && r.fe.na < 0.30, `${k} FENa ${r.fe.na}`);
    assert.ok(r.fe.k > base.fe.k * 2);
    assert.ok(r.fe.ca > base.fe.ca * 3);
    assert.ok(r.fe.mg > base.fe.mg * 3);
    assert.ok(r.Imax < 600 && r.urine.osm < 450);
  }
});

test('thiazide/Gitelman: moderate natriuresis, hypocalciuria, magnesiuria, more K+ loss', () => {
  for (const k of ['thiazide', 'gitelman']) {
    const r = run(k);
    assert.ok(r.fe.na > 0.02 && r.fe.na < 0.06, `${k} FENa ${r.fe.na}`);
    assert.ok(r.fe.ca < base.fe.ca * 0.5);
    assert.ok(r.fe.mg > base.fe.mg);
    assert.ok(r.fe.k > base.fe.k);
  }
});

test('amiloride and spironolactone: natriuresis with K+ retention', () => {
  for (const r of [run('amiloride'), simulate({ drugs: { spironolactone: true } })]) {
    assert.ok(r.fe.na > base.fe.na * 2);
    assert.ok(r.fe.k < base.fe.k * 0.8);
  }
});

test('acetazolamide: bicarbonaturia ~25–35 %, mild natriuresis, kaliuresis', () => {
  const r = run('acetazolamide');
  assert.ok(r.fe.hco3 > 0.2 && r.fe.hco3 < 0.4, `FEHCO3 ${r.fe.hco3}`);
  assert.ok(r.fe.na > 0.01 && r.fe.na < 0.06);
  assert.ok(r.fe.k > base.fe.k);
});

test('SGLT2 inhibitor: glycosuria ~40–90 g/day at normal glucose; SGLT1 takes over part', () => {
  const r = run('sglt2i');
  assert.ok(r.urine.glucoseG > 40 && r.urine.glucoseG < 90, `glc ${r.urine.glucoseG}`);
  assert.ok(r.glucoseSplit.sglt1 > base.glucoseSplit.sglt1 * 3);
  assert.ok(r.fe.na > base.fe.na);
});

test('hyperglycaemia above threshold: glycosuria and osmotic diuresis', () => {
  const r = run('hyperglycemia');
  assert.ok(r.urine.glucoseG > 50);
  assert.ok(r.urine.volume > base.urine.volume * 1.3);
});

test('hyperaldosteronism and Liddle: Na+ retention and K+ wasting', () => {
  for (const k of ['hyperaldosteronism', 'liddle']) {
    const r = run(k);
    assert.ok(r.fe.na < base.fe.na * 0.5, k);
    assert.ok(r.fe.k > base.fe.k * 1.1, k);
  }
});

test('Fanconi: glycosuria, aminoaciduria, phosphaturia, bicarbonaturia, LMW proteinuria', () => {
  const r = run('fanconi');
  assert.ok(r.urine.glucoseG > 1);
  assert.ok(r.fe.aa > 0.1);
  assert.ok(r.fe.pi > 0.3);
  assert.ok(r.fe.hco3 > 0.15);
  assert.ok(r.excreted.b2m > 100 * base.excreted.b2m);
  assert.ok(r.fe.urate > base.fe.urate * 2);
});

test('primary hyperparathyroidism: phosphaturia and hypercalciuria despite ↑ distal Ca reabsorption', () => {
  const r = run('hyperparathyroidism');
  assert.ok(r.fe.pi > base.fe.pi * 2);
  assert.ok(r.excreted.ca > base.excreted.ca * 1.8);
  const dctCa = segmentFractions(r, 'ca').find((x) => x.seg === 'cnt').frac;
  assert.ok(dctCa > segmentFractions(base, 'ca').find((x) => x.seg === 'cnt').frac);
});

test('hypercalcaemia (non-PTH): CaSR → hypercalciuria and concentrating defect', () => {
  const r = run('hypercalcemia');
  assert.ok(r.fe.ca > 0.1);
  assert.ok(r.urine.osm < 450 && r.urine.volume > 3);
});

test('every preset key resolves and differs from normal (except normal)', () => {
  for (const k of PRESET_KEYS) {
    const p = presetParams(k);
    assert.ok(p.plasma && p.act && p.drugs);
    if (k !== 'normal') assert.notDeepEqual(p, mergeParams({}), k);
  }
});

test('purity: simulate does not mutate inputs or defaults', () => {
  const p = presetParams('furosemide');
  const snap = JSON.stringify(p);
  const dsnap = JSON.stringify(DEFAULTS);
  const psnap = JSON.stringify(PRESETS);
  simulate(p); simulate(p); effectiveActivity(p);
  assert.equal(JSON.stringify(p), snap);
  assert.equal(JSON.stringify(DEFAULTS), dsnap);
  assert.equal(JSON.stringify(PRESETS), psnap);
  assert.deepEqual(simulate(p).fe, simulate(p).fe);
});
