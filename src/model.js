// Pure model of tubular reabsorption along the nephron.
// No DOM access. Every function returns new objects and never mutates its input.
//
// Units (per day): water in L, glucose/electrolytes/urea/etc. in mmol,
// β2-microglobulin in mg. Plasma glucose is entered in mg/dL.
//
// The model is a steady-state, single-pass mass balance: the filtered load of each
// substance travels through 8 segments; each segment reabsorbs (or secretes) part
// of what it receives. Drug and disease effects are acute (no systemic
// compensation of plasma values, volume or hormones), see README "Simplifications".

export const SEGMENTS = ['pct', 'tdl', 'atl', 'tal', 'dct', 'cnt', 'ccd', 'mcd'];

export const SUBSTANCES = [
  'water', 'na', 'cl', 'k', 'hco3', 'glucose', 'aa', 'pi',
  'ca', 'mg', 'urea', 'urate', 'citrate', 'b2m',
];

export const UNITS = {
  water: 'L', b2m: 'mg', na: 'mmol', cl: 'mmol', k: 'mmol', hco3: 'mmol', glucose: 'mmol',
  aa: 'mmol', pi: 'mmol', ca: 'mmol', mg: 'mmol', urea: 'mmol', urate: 'mmol', citrate: 'mmol',
};

export const GLUCOSE_MG_PER_MMOL = 180.16;

// Normal adult plasma values (mmol/L unless stated).
export const NORMAL_PLASMA = {
  na: 140, cl: 104, k: 4.5, hco3: 24,
  glucose: 90,   // mg/dL (fasting)
  aa: 2.5,       // total free amino acids
  pi: 1.1,       // inorganic phosphate
  ca: 2.4,       // total calcium
  mg: 0.85,      // total magnesium
  urea: 5,
  urate: 0.3,    // ≈ 5 mg/dL
  citrate: 0.1,
  b2m: 2,        // β2-microglobulin, mg/L
};

// Fraction of plasma concentration that is ultrafilterable (not protein-bound).
export const FILTERABLE = { ca: 0.6, mg: 0.7, pi: 0.95 };

// Baseline fraction of the FILTERED load reabsorbed in each segment
// (negative = net secretion). Standard physiology textbook values
// (Boron & Boulpaep; Koeppen & Stanton; Guyton & Hall). Order = SEGMENTS.
// Used to anchor the load-dependent (saturable) segments; water, glucose, urea
// and phosphate are computed mechanistically instead.
export const BASE = {
  na:      [0.66, 0, 0.02, 0.23, 0.05, 0.02, 0.012, 0.002],
  cl:      [0.58, 0, 0.03, 0.27, 0.07, 0.01, 0.02, 0.015],
  k:       [0.65, 0, 0, 0.25, -0.01, -0.06, -0.04, 0.08],
  hco3:    [0.80, 0, 0, 0.12, 0.04, 0.01, 0.02, 0.0095],
  ca:      [0.65, 0, 0, 0.22, 0.05, 0.06, 0.005, 0],
  mg:      [0.20, 0, 0, 0.65, 0.10, 0, 0, 0],
  pi:      [0.80, 0, 0, 0, 0.05, 0, 0, 0],
};

// Glucose transport maxima at GFR 125 mL/min (mmol/day). Model: tuned so that
// fasting glucose is fully reabsorbed, glycosuria starts near 180–200 mg/dL, total
// Tm ≈ 375 mg/min and an SGLT2 inhibitor leaves ~50–60% of the load to SGLT1.
export const GLUCOSE_TM = { sglt2: 2450, sglt1: 520, theta: 0.93 };

export const DEFAULTS = {
  gfr: 125,       // mL/min
  adh: 0.55,      // 0 = none, 1 = maximal (Model: 0.55 gives Uosm ≈ 650, V ≈ 1.4 L/day)
  aldo: 0.5,      // 0 = none, 0.5 = normal, 1 = maximal
  pth: 0.5,       // 0 = suppressed, 0.5 = normal, 1 = high
  plasma: { ...NORMAL_PLASMA },
  // Transporter / pathway activity multipliers (1 = normal). Diseases set these.
  act: {
    pct: 1,      // global proximal transport capacity (Fanconi syndrome lowers it)
    nhe3: 1, ca: 1, sglt2: 1, sglt1: 1, napi: 1,
    nkcc2: 1, ncc: 1, enac: 1, trpm6: 1, trpv5: 1,
    aqp2: 1,     // collecting-duct response to ADH (V2/AQP2)
    cldn16: 1,   // TAL paracellular Ca/Mg pathway (CaSR → claudin-14 lowers it)
  },
  drugs: {
    furosemide: false, thiazide: false, amiloride: false,
    spironolactone: false, acetazolamide: false, sglt2i: false,
  },
};

// Drug → transporter multiplier (Model: ~85–95 % block at full dose).
export const DRUG_EFFECTS = {
  furosemide: { nkcc2: 0.15 },
  thiazide: { ncc: 0.15, trpm6: 0.7 },
  amiloride: { enac: 0.2 },
  spironolactone: {},             // handled as mineralocorticoid-receptor block
  acetazolamide: { ca: 0.15 },
  sglt2i: { sglt2: 0.05 },
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const cumBase = (s, i) => BASE[s].slice(0, i).reduce((a, b) => a + b, 0);

// Smooth minimum (non-rectangular hyperbola): gives the "splay" of a Tm curve.
export function smoothMin(a, b, theta = 0.97) {
  if (a <= 0 || b <= 0) return 0;
  const s = a + b;
  const disc = s * s - 4 * theta * a * b;
  return (s - Math.sqrt(Math.max(0, disc))) / (2 * theta);
}

// Load-dependent (saturable) reabsorption. Model: activity a multiplies the odds of a
// delivered ion being reabsorbed (baseline fraction f0 = R0/D0), and the segment has a
// finite capacity (~1.7 × its baseline transport × a), combined with a smooth minimum.
// R = R0 when D = D0 and a = 1; R never exceeds D.
const SAT_M = 1.3;
const SAT_THETA = 0.8;
const SAT_NORM = smoothMin(1, SAT_M, SAT_THETA);
function saturable(D, R0, D0, a) {
  if (R0 === 0 || D <= 0 || a <= 0) return 0;
  const f0 = clamp(R0 / D0, 1e-6, 0.995);
  const o = a * (f0 / (1 - f0));
  const demand = D * (o / (1 + o));
  const r = smoothMin(demand, SAT_M * a * R0, SAT_THETA) / SAT_NORM;
  return clamp(r, 0, 0.995 * D);
}

export function mergeParams(params = {}) {
  return {
    ...DEFAULTS,
    ...params,
    plasma: { ...DEFAULTS.plasma, ...(params.plasma || {}) },
    act: { ...DEFAULTS.act, ...(params.act || {}) },
    drugs: { ...DEFAULTS.drugs, ...(params.drugs || {}) },
  };
}

export function effectiveActivity(params) {
  const p = mergeParams(params);
  const act = { ...p.act };
  for (const [drug, on] of Object.entries(p.drugs)) {
    if (!on) continue;
    for (const [k, m] of Object.entries(DRUG_EFFECTS[drug] || {})) act[k] *= m;
  }
  for (const k of Object.keys(act)) act[k] = Math.max(0, act[k]);
  return { act, mrBlock: !!p.drugs.spironolactone };
}

function filteredConc(p, s) {
  if (s === 'glucose') return p.plasma.glucose / 18.016; // mg/dL → mmol/L
  return p.plasma[s] * (FILTERABLE[s] ?? 1);
}
function normalFilteredConc(s) {
  if (s === 'glucose') return NORMAL_PLASMA.glucose / 18.016;
  return NORMAL_PLASMA[s] * (FILTERABLE[s] ?? 1);
}

// Generic walker for the saturable substances. fracPct = fraction of FILTERED
// load reabsorbed in the PCT; acts = activity per downstream segment;
// secrete(i, base) optionally overrides a secreting segment.
function walk(s, F, Fn, fracPct, acts, special = {}) {
  const base = BASE[s];
  const rows = [];
  let D = F;
  let cum = 0;
  SEGMENTS.forEach((seg, i) => {
    let R;
    if (i === 0) {
      R = clamp(fracPct, 0, 0.995) * D;
    } else if (special[seg]) {
      R = special[seg](D);
    } else {
      const D0 = (1 - cum) * Fn;
      R = saturable(D, base[i] * Fn, D0, acts[seg] ?? 1);
    }
    rows.push({ seg, delivered: D, reabsorbed: R, after: D - R });
    D -= R;
    cum += base[i];
  });
  return rows;
}

export function simulate(params = {}) {
  const p = mergeParams(params);
  const { act, mrBlock } = effectiveActivity(p);
  const gf = p.gfr * 1.44;                                   // L/day
  const adhEff = clamp(p.adh, 0, 1) * clamp(act.aqp2, 0, 1.2);
  const aldoF = mrBlock ? 0.3 : 0.3 + 1.4 * clamp(p.aldo, 0, 1);  // ENaC drive
  const aldoNCC = 0.7 + 0.6 * clamp(p.aldo, 0, 1);
  const aldoH = mrBlock ? 0.8 : 0.7 + 0.6 * clamp(p.aldo, 0, 1);
  const pthCa = 0.5 + clamp(p.pth, 0, 1);                    // distal Ca (TRPV5)
  const pthPi = 1.5 - clamp(p.pth, 0, 1);                    // NaPi-IIa (PTH internalises it)
  const adhNK = 0.95 + 0.09 * clamp(p.adh, 0, 1);            // ADH stimulates NKCC2 (modest)
  // Basolateral CaSR in the TAL: hypercalcaemia → claudin-14 ↑ (blocks the Ca/Mg
  // paracellular pathway) and NKCC2 ↓. Model: linear above 2.5 mmol/L total Ca.
  const casr = clamp(1 - 0.6 * (p.plasma.ca - 2.5), 0.3, 1.1);
  const casrNK = clamp(1 - 0.25 * (p.plasma.ca - 2.5), 0.6, 1.05);
  const enacEff = act.enac * aldoF;
  const pctOrg = 0.1 + 0.9 * act.pct;                        // organic-solute capacity

  const F = {}; const Fn = {};
  for (const s of SUBSTANCES) {
    if (s === 'water') { F[s] = gf; Fn[s] = gf; continue; }
    F[s] = gf * filteredConc(p, s);
    Fn[s] = gf * normalFilteredConc(s);
  }
  const seg = {};

  // ---- Glucose (PCT only: SGLT2 in S1–S2, then SGLT1 in S3) ----
  const scale = gf / 180;
  const tm2 = GLUCOSE_TM.sglt2 * scale * act.sglt2 * pctOrg;
  const tm1 = GLUCOSE_TM.sglt1 * scale * act.sglt1 * pctOrg;
  const r2 = smoothMin(F.glucose, tm2, GLUCOSE_TM.theta);
  const r1 = smoothMin(F.glucose - r2, tm1, GLUCOSE_TM.theta);
  const rGlc = r1 + r2;
  seg.glucose = SEGMENTS.map((sg, i) => ({
    seg: sg,
    delivered: i === 0 ? F.glucose : F.glucose - rGlc,
    reabsorbed: i === 0 ? rGlc : 0,
    after: F.glucose - rGlc,
  }));

  // ---- Sodium ----
  // Na+-coupled glucose uptake adds proximal Na reabsorption (capped), while
  // unreabsorbed glucose holds water in the lumen (osmotic diuresis → less Na reabsorbed).
  const nhe3Eff = act.nhe3 * (0.7 + 0.3 * act.ca);
  const sgltTerm = 0.08 * Math.min(rGlc / Fn.glucose, 1.5);
  const glcLeft = F.glucose - rGlc;
  const osmHold = 300 / (300 + 0.5 * glcLeft / (0.34 * gf));
  const fPna = clamp(0.66 * (0.8 + 0.2 * act.pct) * (0.62 * nhe3Eff + sgltTerm + 0.30) * osmHold, 0, 0.8);
  const nkcc2 = act.nkcc2 * casrNK;
  const nk = nkcc2 * adhNK;
  seg.na = walk('na', F.na, Fn.na, fPna, {
    atl: nkcc2, tal: nk, dct: act.ncc * aldoNCC,
    cnt: enacEff, ccd: enacEff, mcd: enacEff,
  });
  const pctScale = fPna / 0.66;  // other passive PCT solutes follow Na (and water)

  // Medullary interstitial osmolality (Model): built by TAL NaCl transport and
  // ADH-dependent urea recycling. 1200 mOsm/kg with a normal TAL and maximal ADH.
  const R0tal = BASE.na[3] * Fn.na;
  const gTAL = clamp(seg.na[3].reabsorbed / R0tal, 0, 1);
  const Imax = 300 + 900 * gTAL * (0.55 + 0.45 * adhEff);

  // ---- Water: PCT (isosmotic, osmotic diuresis from unreabsorbed glucose) and tDL ----
  const wPCT = gf * fPna;            // isosmotic (AQP1)
  const wAfterPCT = gf - wPCT;
  const wTDL = wAfterPCT * clamp(0.44 * (Imax - 300) / 900, 0, 0.6);
  const wDist = wAfterPCT - wTDL;   // delivered to the distal nephron (ATL..DCT impermeable)

  // ---- Potassium ----
  const flowF = Math.sqrt(Math.max(wDist, 0) / (0.22 * gf));
  const kF = p.plasma.k / NORMAL_PLASMA.k;
  // K+ secretion (negative reabsorption) in DCT2, CNT and CCD. Model: driven by ENaC
  // activity (lumen-negative voltage; includes aldosterone), luminal Na+ delivery,
  // distal flow (BK channels) and plasma K+.
  const secr = (i) => (D) => {
    const naDel = seg.na[i].delivered / Math.max((1 - cumBase('na', i)) * Fn.na, 1e-9);
    const s = BASE.k[i] * Fn.k * enacEff * Math.sqrt(Math.max(naDel, 0)) * flowF * kF;
    return Math.max(s, -3 * Fn.k);   // negative = secretion
  };
  seg.k = walk('k', F.k, Fn.k, 0.65 * pctScale, { tal: nk }, {
    dct: secr(4), cnt: secr(5), ccd: secr(6),
    mcd: (D) => D * clamp(0.38 / kF, 0, 0.7),      // H+/K+-ATPase (α-intercalated), up in hypokalaemia
  });

  // ---- Chloride ----
  seg.cl = walk('cl', F.cl, Fn.cl, 0.58 * pctScale, {
    atl: nkcc2, tal: nk, dct: act.ncc * aldoNCC,
    cnt: enacEff, ccd: enacEff, mcd: enacEff,
  });

  // ---- Bicarbonate ----
  const hF = aldoH * (0.5 + 0.5 * act.ca) * (0.6 + 0.4 * Math.min(1.3, act.enac));
  seg.hco3 = walk('hco3', F.hco3, Fn.hco3,
    clamp(0.80 * (0.3 + 0.7 * act.pct) * (0.45 + 0.55 * act.ca) * act.nhe3, 0, 0.95),
    { tal: 1, dct: 1, cnt: hF, ccd: hF, mcd: hF });

  // ---- Calcium ----
  const tiazCa = 1 + 0.6 * (1 - Math.min(1, act.ncc));
  const caDist = act.trpv5 * pthCa * tiazCa;
  seg.ca = walk('ca', F.ca, Fn.ca, 0.65 * pctScale, {
    tal: (0.3 + 0.7 * nkcc2) * act.cldn16 * casr, dct: caDist, cnt: caDist, ccd: 1,
  });

  // ---- Magnesium ----
  seg.mg = walk('mg', F.mg, Fn.mg, 0.20 * pctScale, {
    tal: (0.3 + 0.7 * nkcc2) * act.cldn16 * casr, dct: act.trpm6,
  });

  // ---- Phosphate (PCT Tm-limited: NaPi-IIa/IIc, inhibited by PTH/FGF23) ----
  const tmP = 1.0 * gf * act.napi * pthPi * pctOrg;  // TmP/GFR ≈ 1.0 mmol/L at normal PTH
  const rPi = smoothMin(0.9 * F.pi, tmP, 0.99);
  seg.pi = walk('pi', F.pi, Fn.pi, rPi / Math.max(F.pi, 1e-9), { dct: 1 });

  // ---- Simple PCT-only solutes ----
  const pctOnly = (s, frac) => {
    const R = clamp(frac, 0, 0.9995) * F[s];
    return SEGMENTS.map((sg, i) => ({
      seg: sg, delivered: i === 0 ? F[s] : F[s] - R, reabsorbed: i === 0 ? R : 0, after: F[s] - R,
    }));
  };
  seg.aa = pctOnly('aa', 0.99 - 0.4 * (1 - act.pct));
  seg.urate = pctOnly('urate', 0.90 - 0.5 * (1 - act.pct));    // net (reabsorption − secretion)
  seg.citrate = pctOnly('citrate', 0.80 * (0.6 + 0.4 * act.pct));
  seg.b2m = pctOnly('b2m', 0.999 - 0.95 * (1 - act.pct));     // megalin–cubilin endocytosis

  // ---- Urea (passive in PCT; enters thin limbs; ADH/UT-A1 reabsorption in IMCD) ----
  {
    const rows = [];
    let D = F.urea;
    const fPctUrea = 0.5 * (wPCT / (0.66 * gf));
    const loopEntry = 0.6 * adhEff * F.urea;
    SEGMENTS.forEach((sg) => {
      let R = 0;
      if (sg === 'pct') R = clamp(fPctUrea, 0, 0.8) * D;
      else if (sg === 'tdl') R = -0.6 * loopEntry;
      else if (sg === 'atl') R = -0.4 * loopEntry;
      else if (sg === 'mcd') R = 0.75 * adhEff * D;
      rows.push({ seg: sg, delivered: D, reabsorbed: R, after: D - R });
      D -= R;
    });
    seg.urea = rows;
  }

  // ---- Water in the collecting system (osmotic equilibration, ADH-dependent) ----
  const osmAt = (i) => 2 * (seg.na[i].after + seg.k[i].after) + seg.urea[i].after + seg.glucose[i].after;
  const iDCT = 4, iCNT = 5, iCCD = 6, iMCD = 7;
  const Odct = osmAt(iDCT) / Math.max(wDist, 1e-9);
  const Occd = Odct < 300 ? Odct + (300 - Odct) * adhEff : Odct;
  const wAfterCCD = Math.min(wDist, osmAt(iCCD) / Occd);
  const UosmTarget = Occd + Math.max(0, Imax - Occd) * adhEff;
  const V = Math.min(wAfterCCD, osmAt(iMCD) / UosmTarget);
  const wCC = wDist - wAfterCCD;
  const water = [wPCT, wTDL, 0, 0, 0, 0.4 * wCC, 0.6 * wCC, wAfterCCD - V];
  {
    let D = gf;
    seg.water = SEGMENTS.map((sg, i) => {
      const row = { seg: sg, delivered: D, reabsorbed: water[i], after: D - water[i] };
      D -= water[i];
      return row;
    });
  }
  const Uosm = osmAt(iMCD) / V;

  // Tubular-fluid osmolality profile (Model: hairpin and thin ascending limb follow
  // a long-loop juxtamedullary nephron; other points are mass balance).
  const wAt = (i) => seg.water[i].after;
  const osmProfile = [
    { point: 'bowman', value: (2 * (F.na + F.k) + F.urea + F.glucose) / gf },
    { point: 'pct', value: osmAt(0) / wAt(0) },
    { point: 'tdl', value: Imax },
    { point: 'atl', value: 300 + (Imax - 300) * 0.45 },
    { point: 'tal', value: osmAt(3) / wAt(3) },
    { point: 'dct', value: osmAt(iDCT) / wAt(iDCT) },
    { point: 'cnt', value: osmAt(iCNT) / wAt(iCNT) },
    { point: 'ccd', value: osmAt(iCCD) / wAt(iCCD) },
    { point: 'mcd', value: Uosm },
  ];

  const excreted = {}; const fe = {}; const filtered = {};
  for (const s of SUBSTANCES) {
    filtered[s] = F[s];
    excreted[s] = seg[s][SEGMENTS.length - 1].after;
    fe[s] = F[s] > 0 ? excreted[s] / F[s] : 0;
  }

  return {
    params: p,
    gfrLday: gf,
    adhEff, Imax,
    filtered, excreted, fe, seg, osmProfile,
    glucoseSplit: { sglt2: r2, sglt1: r1 },
    urine: {
      volume: V,                    // L/day
      osm: Uosm,                    // mOsm/kg
      flow: (V * 1000) / 1440,      // mL/min
      osmoles: osmAt(iMCD),         // mOsm/day (Na, K, anions, urea, glucose)
      glucoseG: (excreted.glucose * GLUCOSE_MG_PER_MMOL) / 1000,
    },
  };
}

// Fraction of the filtered load handled in each segment (negative = secretion).
export function segmentFractions(result, s) {
  const F = result.filtered[s];
  return result.seg[s].map((r) => ({ seg: r.seg, frac: F > 0 ? r.reabsorbed / F : 0 }));
}

// Fraction of the filtered load still in the lumen at the start and after each segment.
export function remainingProfile(result, s) {
  const F = result.filtered[s];
  return [1, ...result.seg[s].map((r) => (F > 0 ? r.after / F : 0))];
}

// Presets: generic clinical situations. Each sets params from DEFAULTS.
export const PRESETS = {
  normal: {},
  dehydration: { adh: 1, aldo: 0.8 },
  centralDI: { adh: 0 },
  nephrogenicDI: { adh: 1, act: { aqp2: 0.05 } },
  furosemide: { drugs: { furosemide: true } },
  thiazide: { drugs: { thiazide: true } },
  amiloride: { drugs: { amiloride: true } },
  acetazolamide: { drugs: { acetazolamide: true } },
  sglt2i: { drugs: { sglt2i: true } },
  hyperglycemia: { plasma: { glucose: 320 } },
  hyperaldosteronism: { aldo: 1 },
  liddle: { aldo: 0.1, act: { enac: 4 } },
  bartter: { act: { nkcc2: 0.15 } },
  gitelman: { act: { ncc: 0.1, trpm6: 0.5 } },
  fanconi: { act: { pct: 0.35 } },
  hyperparathyroidism: { pth: 1, plasma: { ca: 2.9, pi: 0.8 } },
  hypercalcemia: { pth: 0.05, plasma: { ca: 3.4 }, act: { aqp2: 0.6 } },
};

export const PRESET_KEYS = Object.keys(PRESETS);

export function presetParams(key) {
  const pr = PRESETS[key] || {};
  return mergeParams(JSON.parse(JSON.stringify(pr)));
}

// Reference ranges for the final urine (used for flags in the UI).
export const REFERENCE = {
  volume: [0.8, 2.5],      // L/day
  osm: [50, 1200],         // mOsm/kg, physiological limits
  feNa: [0.002, 0.01],
  feK: [0.05, 0.2],
  feCa: [0.005, 0.025],  // < 0.5 % = hypocalciuria (e.g. thiazide, Gitelman)
  feMg: [0.02, 0.05],
  fePi: [0.05, 0.2],
  feUrea: [0.3, 0.6],
};
