
/*
v5p24 circuit net isolation fix
- Keep pass-through literal terms on their own literal nets when feeding the final gate
- Prevent different literal inputs from merging into synthetic T/F nets
- Preserve single multi-literal term output routing to F
- Retain v5p23 circuit output, spacing, and XOR hint fixes
*/

import { useState, useCallback, useMemo, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════════
//  K-MAP CORE - dynamic 2/3/4 variable support
// ═══════════════════════════════════════════════════════════
const GROUP_COLORS = ["#e53935","#1e88e5","#43a047","#fb8c00","#8e24aa","#00897b"];
const ALL_VARS = ["A","B","C","D"];

function grayCodes(bits) {
  if (!Number.isFinite(bits) || bits <= 0) return [""];
  let arr = ["0","1"];
  for (let b=2; b<=bits; b++) arr = [...arr.map(x=>"0"+x), ...arr.slice().reverse().map(x=>"1"+x)];
  return arr;
}

function getKmapConfig(varCount) {
  const rowBits = varCount <= 2 ? 1 : Math.floor(varCount / 2);
  const colBits = varCount - rowBits;
  const rowGray = grayCodes(rowBits);
  const colGray = grayCodes(colBits);
  const vars = ALL_VARS.slice(0, varCount);
  return {
    varCount, vars, rowBits, colBits, rowGray, colGray,
    rows: rowGray.length,
    cols: colGray.length,
    total: 1 << varCount,
    rowLabel: vars.slice(0, rowBits).join(""),
    colLabel: vars.slice(rowBits).join(""),
  };
}

function cellToMinterm(row, col, cfg) {
  const bits = `${cfg.rowGray[row] ?? ""}${cfg.colGray[col] ?? ""}`;
  return bits ? parseInt(bits, 2) : 0;
}
function bitOf(m, bit, varCount=4) { return (m >> (varCount-1-bit)) & 1; }
function bitCount(n) { let c=0; while(n){c+=n&1;n>>=1;} return c; }
function uniqGroupKey(g) { return [...g].sort((a,b)=>a-b).join(","); }

function powersUpTo(n) { const out=[]; for(let p=1;p<=n;p*=2) out.push(p); return out; }

function generateValidGroups(cfg) {
  const { rows, cols } = cfg;
  const groups = [];
  const seen = new Set();
  for (const rh of powersUpTo(rows)) {
    for (const cw of powersUpTo(cols)) {
      const size = rh * cw;
      if ((size & (size-1)) !== 0) continue;
      for (let r0=0; r0<rows; r0++) {
        for (let c0=0; c0<cols; c0++) {
          const cells = [];
          for (let dr=0; dr<rh; dr++) for (let dc=0; dc<cw; dc++) {
            cells.push(cellToMinterm((r0+dr)%rows, (c0+dc)%cols, cfg));
          }
          const uniq = [...new Set(cells)];
          if (uniq.length !== size) continue;
          const key = uniqGroupKey(uniq);
          if (!seen.has(key)) { seen.add(key); groups.push(uniq); }
        }
      }
    }
  }
  return groups.sort((a,b)=> b.length-a.length || a[0]-b[0]);
}

// target cells must be covered; helper cells are don't-care cells that may enlarge groups.
function findGroups(targets, helpers=[], cfg=getKmapConfig(4)) {
  if (!targets.length) return [];
  const targetSet = new Set(targets);
  const allowed = new Set([...targets, ...helpers]);
  const cands = generateValidGroups(cfg)
    .filter(g => {
      if (allowed.size !== cfg.total && g.length === cfg.total) return false;
      return g.every(m => allowed.has(m)) && g.some(m => targetSet.has(m));
    })
    .sort((a,b) => b.length - a.length || a[0] - b[0]);

  // v5p1: exact small-set cover instead of greedy-only cover.
  // K-maps are at most 16 cells here, so we can choose the best cover by:
  // 1) fewest groups, 2) fewest total literals, 3) largest total covered area.
  // This prevents greedy choices from missing a smaller/cleaner expression.
  const targetIndex = new Map(targets.map((m,i)=>[m,i]));
  const fullMask = targets.reduce((mask,m)=> mask | (1 << targetIndex.get(m)), 0);
  const litCost = (g) => cfg.varCount - Math.round(Math.log2(Math.max(1, g.length)));
  const candObjs = cands.map((g, idx) => {
    let mask = 0;
    g.forEach(m => { if (targetIndex.has(m)) mask |= (1 << targetIndex.get(m)); });
    return { g, idx, mask, lit: litCost(g), area:g.length };
  }).filter(c => c.mask !== 0);

  let best = null;
  const scoreBetter = (a, b) => {
    if (!b) return true;
    if (a.length !== b.length) return a.length < b.length;
    const al = a.reduce((s,c)=>s+c.lit,0), bl = b.reduce((s,c)=>s+c.lit,0);
    if (al !== bl) return al < bl;
    const aa = a.reduce((s,c)=>s+c.area,0), ba = b.reduce((s,c)=>s+c.area,0);
    if (aa !== ba) return aa > ba;
    return a.map(c=>c.idx).join(',') < b.map(c=>c.idx).join(',');
  };

  const coverers = targets.map(m => candObjs.filter(c => c.mask & (1 << targetIndex.get(m))));
  const dfs = (coveredMask, chosen) => {
    if (best && chosen.length >= best.length) return;
    if (coveredMask === fullMask) {
      if (scoreBetter(chosen, best)) best = [...chosen];
      return;
    }
    let firstUncovered = -1;
    for (let i=0; i<targets.length; i++) if (!(coveredMask & (1 << i))) { firstUncovered = i; break; }
    if (firstUncovered < 0) return;
    for (const c of coverers[firstUncovered]) {
      if ((c.mask & ~coveredMask) === 0) continue;
      chosen.push(c);
      dfs(coveredMask | c.mask, chosen);
      chosen.pop();
    }
  };
  dfs(0, []);

  if (best && best.length) return best.map(c => c.g);
  return targets.map(m => [m]);
}

function groupToSopTerms(group, vars=ALL_VARS, varCount=vars.length) {
  return vars.map((v, bit) => {
    const vals = group.map(m => bitOf(m, bit, varCount));
    if (vals.every(x => x === 1)) return { var:v, inv:false };
    if (vals.every(x => x === 0)) return { var:v, inv:true };
    return null;
  }).filter(Boolean);
}

function groupToPosTerms(group, vars=ALL_VARS, varCount=vars.length) {
  // Maxterm from grouped zero cells: bit 0 => A, bit 1 => A'
  return vars.map((v, bit) => {
    const vals = group.map(m => bitOf(m, bit, varCount));
    if (vals.every(x => x === 0)) return { var:v, inv:false };
    if (vals.every(x => x === 1)) return { var:v, inv:true };
    return null;
  }).filter(Boolean);
}

function literalText(t) { return t.inv ? `${t.var}'` : t.var; }
function sopTermExpr(terms) { return terms.length ? terms.map(literalText).join("·") : "1"; }
function posTermExpr(terms) { return terms.length ? `(${terms.map(literalText).join(" + ")})` : "0"; }

function coloredTermList(termsList, form="SOP") {
  return termsList.map((terms, i) => ({
    key: `${form}_${i}`,
    color: GROUP_COLORS[i % GROUP_COLORS.length],
    text: form === "SOP" ? sopTermExpr(terms) : posTermExpr(terms),
  }));
}
function joinExprTerms(items, joiner) {
  return items.length ? items.map(x => x.text).join(joiner) : "";
}

function stableKeyForGroup(form, index) {
  return `${form}_${index}`;
}

function groupBounds(group, cfg) {
  const positions = [];
  for (let r=0; r<cfg.rows; r++) for (let c=0; c<cfg.cols; c++) {
    const m = cellToMinterm(r, c, cfg);
    if (group.includes(m)) positions.push({r,c,m});
  }
  if (!positions.length) return null;

  const rows = [...new Set(positions.map(p=>p.r))].sort((a,b)=>a-b);
  const cols = [...new Set(positions.map(p=>p.c))].sort((a,b)=>a-b);
  const contiguousSpan = (arr, total) => {
    if (arr.length === total) return { start:0, count:total, wraps:false };
    let best = null;
    for (const start of arr) {
      let count = 1;
      while (count < total && arr.includes((start + count) % total)) count++;
      const covers = arr.every(v => (v - start + total) % total < count);
      if (covers && (!best || count < best.count)) best = { start, count, wraps:start + count > total };
    }
    return best || { start:arr[0], count:arr.length, wraps:false };
  };

  return {
    row: contiguousSpan(rows, cfg.rows),
    col: contiguousSpan(cols, cfg.cols),
    rows,
    cols,
    positions
  };
}



function kmapSvgGroupLoopRects(group, index, cfg, cellX, cellY, cellSize) {
  const b = groupBounds(group, cfg);
  if (!b) return [];
  const margin = 5 + (index % 2) * 3;

  const makeRect = (rStart, rCount, cStart, cCount, suffix="") => {
    const cEnd = cStart + cCount - 1;
    const rEnd = rStart + rCount - 1;
    const left = cellX(cStart) - margin;
    const top = cellY(rStart) - margin;
    const right = cellX(cEnd) + cellSize + margin;
    const bottom = cellY(rEnd) + cellSize + margin;
    return {
      key:`${index}_${suffix}_${rStart}_${cStart}`,
      x:left,
      y:top,
      w:right-left,
      h:bottom-top
    };
  };

  const rowParts = b.row.wraps
    ? [{start:b.row.start,count:cfg.rows-b.row.start,suffix:"ra"},{start:0,count:(b.row.start+b.row.count)%cfg.rows,suffix:"rb"}].filter(p=>p.count>0)
    : [{start:b.row.start,count:b.row.count,suffix:"r"}];

  const colParts = b.col.wraps
    ? [{start:b.col.start,count:cfg.cols-b.col.start,suffix:"ca"},{start:0,count:(b.col.start+b.col.count)%cfg.cols,suffix:"cb"}].filter(p=>p.count>0)
    : [{start:b.col.start,count:b.col.count,suffix:"c"}];

  const rects = [];
  rowParts.forEach(rp => colParts.forEach(cp => rects.push(makeRect(rp.start, rp.count, cp.start, cp.count, `${rp.suffix}_${cp.suffix}`))));
  return rects;
}



function detectAffineXor(cells, vars=ALL_VARS) {
  const varCount = vars.length;
  const known = cells.map((v,i)=>({v,i})).filter(x => x.v !== 2);
  if (known.length === 0) return null;
  const masks = [];
  for (let mask=1; mask<(1<<varCount); mask++) if (bitCount(mask) >= 2) masks.push(mask);
  masks.sort((a,b)=> bitCount(a)-bitCount(b) || a-b);
  for (const mask of masks) {
    for (const invert of [0,1]) {
      const ok = known.every(({v,i}) => {
        let p = invert;
        for (let bit=0; bit<varCount; bit++) if (mask & (1 << (varCount-1-bit))) p ^= bitOf(i, bit, varCount);
        return p === v;
      });
      if (ok) {
        const used = vars.filter((_,bit)=> mask & (1 << (varCount-1-bit)));
        return { used, invert: !!invert, expr: used.join(" ⊕ "), kind: invert ? "XNOR/PARITY'" : "XOR/PARITY" };
      }
    }
  }
  return null;
}

function buildPlans(cells, vars=ALL_VARS) {
  const cfg = getKmapConfig(vars.length);
  const total = cfg.total;
  const ones  = cells.map((v,i)=>v===1?i:-1).filter(i=>i>=0);
  const zeros = cells.map((v,i)=>v===0?i:-1).filter(i=>i>=0);
  const xs    = cells.map((v,i)=>v===2?i:-1).filter(i=>i>=0);

  const sanitizeGroups = (groups, targets, helpers, termFn) => {
    const isConstCase = targets.length === 0 || targets.length === total ||
      (targets.length > 0 && new Set([...targets, ...helpers]).size === total);
    const pairs = groups.map(g => ({ group:g, terms:termFn(g, vars, vars.length) }));
    if (isConstCase) return pairs;

    if (pairs.every(p => p.terms.length > 0)) return pairs;

    // Defensive fallback: empty term lists are legal only for true constants.
    // If a future grouping path produces one in a non-constant map, rebuild from
    // single target cells so the expression cannot collapse to F=1 or F=0.
    return targets.map(m => ({ group:[m], terms:termFn([m], vars, vars.length) }));
  };

  const sopPairs = sanitizeGroups(findGroups(ones, xs, cfg), ones, xs, groupToSopTerms);
  const posPairs = sanitizeGroups(findGroups(zeros, xs, cfg), zeros, xs, groupToPosTerms);
  const sopGroups = sopPairs.map(p => p.group);
  const posGroups = posPairs.map(p => p.group);
  const sopTerms = sopPairs.map(p => p.terms);
  const posTerms = posPairs.map(p => p.terms);

  const sop = {
    form:"SOP", vars, cfg,
    target: ones,
    groups: sopGroups,
    termsList: sopTerms,
    expr: ones.length === 0 ? "F = 0" : ones.length === total ? "F = 1" : "F = " + sopTerms.map(sopTermExpr).join(" + "),
  };
  const pos = {
    form:"POS", vars, cfg,
    target: zeros,
    groups: posGroups,
    termsList: posTerms,
    expr: zeros.length === 0 ? "F = 1" : zeros.length === total ? "F = 0" : "F = " + posTerms.map(posTermExpr).join(" · "),
  };
  sop.metrics = estimateMetrics(sop, "standard");
  pos.metrics = estimateMetrics(pos, "standard");
  const xor = detectAffineXor(cells, vars);
  return { ones, zeros, xs, sop, pos, xor, cfg, vars };
}

function literalCount(plan) { return plan.termsList.reduce((s,t)=>s+t.length,0); }
function usedInverters(plan) {
  const inv = new Set();
  plan.termsList.forEach(ts => ts.forEach(t => { if (t.inv) inv.add(t.var); }));
  return inv.size;
}
function estimateMetrics(plan, impl="standard") {
  const terms = plan.termsList;
  const nonConstTerms = terms.filter(t => t.length > 0);
  const literals = literalCount(plan);
  const invCount = usedInverters(plan);
  const isConst = plan.expr === "F = 0" || plan.expr === "F = 1";
  if (isConst) return { gates:1, literals:0, depth:0, inverters:0 };

  // Logic depth = maximum number of logic gates on any input-to-output path.
  // Wires and direct single-literal pass-through are depth 0.
  const termInputDepth = (terms) => terms.reduce((m,t)=>Math.max(m, t.inv ? 1 : 0), 0);

  if (impl === "nand") {
    // NAND-NAND implementation of SOP. Inverted literals are made by NAND-as-inverter.
    const productDepths = nonConstTerms.map(ts => termInputDepth(ts) + (ts.length > 1 ? 1 : 0));
    const finalDepth = nonConstTerms.length > 1 ? 1 : 0;
    const depth = (productDepths.length ? Math.max(...productDepths) : 0) + finalDepth;
    const productGates = nonConstTerms.filter(ts=>ts.length>1).length;
    const final = nonConstTerms.length > 1 ? 1 : 0;
    return { gates: invCount + productGates + final, literals, depth, inverters:invCount };
  }
  if (impl === "nor") {
    // NOR-NOR implementation of POS. Inverted literals are made by NOR-as-inverter.
    const sumDepths = nonConstTerms.map(ts => termInputDepth(ts) + (ts.length > 1 ? 1 : 0));
    const finalDepth = nonConstTerms.length > 1 ? 1 : 0;
    const depth = (sumDepths.length ? Math.max(...sumDepths) : 0) + finalDepth;
    const sumGates = nonConstTerms.filter(ts=>ts.length>1).length;
    const final = nonConstTerms.length > 1 ? 1 : 0;
    return { gates: invCount + sumGates + final, literals, depth, inverters:invCount };
  }
  const firstGates = nonConstTerms.filter(t=>t.length>1).length;
  const final = nonConstTerms.length > 1 ? 1 : 0;
  const firstDepths = nonConstTerms.map(ts => termInputDepth(ts) + (ts.length > 1 ? 1 : 0));
  const depth = (firstDepths.length ? Math.max(...firstDepths) : 0) + final;
  return { gates: invCount + firstGates + final, literals, depth, inverters:invCount };
}

function choosePlan(plans, optMode, implMode) {
  if (implMode === "nand") return plans.sop; // NAND-NAND maps naturally from SOP.
  if (implMode === "nor") return plans.pos;  // NOR-NOR maps naturally from POS.
  if (optMode === "sop") return plans.sop;
  if (optMode === "pos") return plans.pos;
  const s = plans.sop.metrics, p = plans.pos.metrics;
  if (p.gates < s.gates) return plans.pos;
  if (p.gates === s.gates && p.literals < s.literals) return plans.pos;
  return plans.sop;
}

// ═══════════════════════════════════════════════════════════
//  GATE SHAPES
// ═══════════════════════════════════════════════════════════
const AND_W = 54, AND_H = 20, OR_W = 70;
const NOT_W = 32, NOT_H = 11;
const AND_BODY_RATIO = 0.54;
const AND_BUBBLE_R = 4.2;
const OR_INPUT_BACK_RATIO = 0.10;
const OR_BUBBLE_R = 4.8;
const NOT_BUBBLE_R = 3.6;
const andGateBaseOutX = (x, h, w=AND_W) => x + w * AND_BODY_RATIO + h;
const andGateOutputX = (x, h, bubble=false, w=AND_W) => andGateBaseOutX(x, h, w) + (bubble ? AND_BUBBLE_R * 2 + 0.1 : 0);
const orGateInputX = (x) => x + OR_W * OR_INPUT_BACK_RATIO;
const orGateOutputX = (x, bubble=false) => x + OR_W + (bubble ? OR_BUBBLE_R * 2 + 1 : 0);
const notGateOutputX = (x) => x + NOT_W + NOT_BUBBLE_R + 2;
const CIRCUIT_PAD = 96;
const WIRE_GAP = 8;
function makeGridDots(W, H, keyPrefix="grid") {
  const dots = [];
  for (let xi=1; xi*24<=W-12; xi++) for (let yi=1; yi*24<=H-12; yi++) {
    dots.push(<circle key={`${keyPrefix}_${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);
  }
  return dots;
}

function AndGate({ x, y, label="AND", bubble=false, w=AND_W, h=AND_H }) {
  const bodyW = w * AND_BODY_RATIO;
  const gateH = h;
  const out = andGateBaseOutX(x, gateH, w);
  const bubbleR = AND_BUBBLE_R;
  return <g>
    <path
      d={`M${x},${y-gateH} H${x+bodyW} A${gateH},${gateH} 0 0,1 ${x+bodyW},${y+gateH} H${x} Z`}
      fill="#fff"
      stroke="#111"
      strokeWidth="1.9"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    {bubble && <circle cx={out+bubbleR} cy={y} r={bubbleR} fill="#fff" stroke="#111" strokeWidth="1.9" />}
    <text x={x+bodyW*0.48} y={y+4} textAnchor="middle" fontSize="8.2" fontFamily="Arial,sans-serif" fontWeight="800">{label}</text>
  </g>;
}

function OrGate({ x, y, h=26, label="OR", bubble=false }) {
  // American / ANSI OR/NOR symbol.
  // Shape rules:
  // - no vertical input wall
  // - short straight top/bottom shoulders
  // - concave input curve
  // - pointed output nose
  const w = OR_W;
  const r = OR_BUBBLE_R;

  const left = x;
  const right = x + w;
  const top = y - h;
  const bottom = y + h;

  const shoulder = w * 0.26;     // short top/bottom straight segment
  const back = w * OR_INPUT_BACK_RATIO; // left start of the curved input side

  const d = `
    M ${left + back} ${top}
    L ${left + shoulder} ${top}
    C ${left + w*0.54} ${top}, ${left + w*0.82} ${y - h*0.58}, ${right} ${y}
    C ${left + w*0.82} ${y + h*0.58}, ${left + w*0.54} ${bottom}, ${left + shoulder} ${bottom}
    L ${left + back} ${bottom}
    C ${left + w*0.28} ${y + h*0.48}, ${left + w*0.28} ${y - h*0.48}, ${left + back} ${top}
    Z
  `;

  return <g>
    <path
      d={d}
      fill="#fff"
      stroke="#111"
      strokeWidth="1.9"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    {bubble && <circle cx={right+OR_BUBBLE_R+1} cy={y} r={OR_BUBBLE_R} fill="#fff" stroke="#111" strokeWidth="1.9" />}
    <text x={x+w*0.50} y={y+4} textAnchor="middle" fontSize="8.2" fontFamily="Arial,sans-serif" fontWeight="800">{label}</text>
  </g>;
}

function NotGate({ x, y, label="INV" }) {
  const bubbleR = NOT_BUBBLE_R;
  return <g>
    <polygon
      points={`${x},${y-NOT_H} ${x+NOT_W-8},${y} ${x},${y+NOT_H}`}
      fill="#fff"
      stroke="#111"
      strokeWidth="1.9"
      strokeLinejoin="round"
    />
    <circle cx={x+NOT_W-4} cy={y} r={bubbleR} fill="#fff" stroke="#111" strokeWidth="1.9" />
    {label && <text x={x+NOT_W/2-5} y={y+3.2} textAnchor="middle" fontSize="6.4" fontFamily="Arial,sans-serif" fontWeight="800">{label}</text>}
  </g>;
}

function XorGate({ x, y, label="XOR", bubble=false }) {
  // American / ANSI XOR/XNOR symbol.
  // XOR = OR body + a separate parallel input curve.
  // XNOR = XOR + output inversion bubble.
  const w = OR_W;
  const h = 26;

  const extraLeft = x - 14;
  const extraTop = y - h;
  const extraBottom = y + h;
  const right = x + w;

  return <g>
    <path
      d={`
        M ${extraLeft} ${extraTop}
        C ${extraLeft + 20} ${y - h*0.46}, ${extraLeft + 20} ${y + h*0.46}, ${extraLeft} ${extraBottom}
      `}
      fill="none"
      stroke="#111"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
    <OrGate x={x} y={y} h={h} label={label} />
    {bubble && <circle cx={right+OR_BUBBLE_R+1} cy={y} r={OR_BUBBLE_R} fill="#fff" stroke="#111" strokeWidth="1.9" />}
  </g>;
}

function outX(kind, x, impl="standard") {
  if (kind === "or") return orGateOutputX(x, impl === "nor");
  if (kind === "and") return andGateOutputX(x, AND_H, impl === "nand", AND_W);
  if (kind === "xor") return orGateOutputX(x, false);
  return x;
}
function implementationCost(plan, impl) {
  const m = estimateMetrics(plan, impl);
  return m.gates;
}
function recommendationSummary(plans, detectXor) {
  const candidates = [
    { name:"SOP · Standard", plan:plans.sop, impl:"standard" },
    { name:"POS · Standard", plan:plans.pos, impl:"standard" },
    { name:"SOP · NAND", plan:plans.sop, impl:"nand" },
    { name:"POS · NOR", plan:plans.pos, impl:"nor" },
  ].map(c => {
    const m = estimateMetrics(c.plan, c.impl);
    return { ...c, gates:m.gates, literals:m.literals, depth:m.depth, cost:implementationCost(c.plan, c.impl) };
  });
  if (detectXor && plans.xor) {
    const xorInputs = plans.xor.used.length;
    candidates.push({ name:"XOR/XNOR Pattern", plan:null, impl:"xor", gates:1, literals:xorInputs, depth:1, cost:Math.max(2, xorInputs) });
  }
  candidates.sort((a,b)=> a.cost-b.cost || a.gates-b.gates || a.depth-b.depth || a.literals-b.literals);
  return { best:candidates[0], candidates };
}

// ═══════════════════════════════════════════════════════════
//  CIRCUIT RENDERER - trunked rails with explicit branch dots
// ═══════════════════════════════════════════════════════════
function CircuitDiagram({ plan, implMode, xorInfo, xorEnabled }) {
  // XOR visualization is intentionally limited to Standard SOP display.
  // NAND/NOR and explicit POS display keep their selected implementation structure.
  const forceXor = implMode === "standard" && xorEnabled === true && !!xorInfo && plan.form === "SOP";
  if (forceXor) {
    const xorKey = `xor_${(xorInfo.used || []).join("_")}_${xorInfo.invert ? "inv" : "raw"}`;
    return <XorCircuit key={xorKey} xorInfo={xorInfo} />;
  }

  const termsList = plan.termsList;
  const vars = plan.vars || ALL_VARS;
  const form = implMode === "nand" ? "SOP" : implMode === "nor" ? "POS" : plan.form;

  const isZero = plan.expr === "F = 0";
  const isOne = plan.expr === "F = 1";
  if (isZero || isOne) return <ConstCircuit value={isOne ? 1 : 0} />;
  if (implMode === "standard" && termsList.length === 1 && termsList[0]?.length === 1) {
    return <SingleLiteralCircuit term={termsList[0][0]} vars={vars} />;
  }
  return <StableCircuit plan={plan} implMode={implMode} />;
}
function StableCircuit({ plan, implMode="standard" }) {
  const C = "#111", SW = 1.75;
  const termsList = plan.termsList || [];
  const vars = plan.vars || ALL_VARS;
  const form = implMode === "nand" ? "SOP" : implMode === "nor" ? "POS" : plan.form;
  const termCount = termsList.length;
  if (!termCount) return <ConstCircuit value={plan.expr === "F = 1" ? 1 : 0} />;

  // v4p17 polyline route validator
  // Wire rule: no freehand segments. Every visible wire is created only from
  // connect(fromPin, toPin). Intermediate bend points are internal to that one
  // request. Floating nets become structurally impossible unless a route lacks
  // both a source and a sink, and the validator removes those components.
  // Dot rule: a dot means a real electrical fanout/tap only. Elbows, crossings,
  // gate pins, and output terminals are never dot candidates.

  const isNand = implMode === "nand";
  const isNor = implMode === "nor";
  const termKind = isNand ? "nand" : isNor ? "nor" : form === "SOP" ? "and" : "or";
  const finalKind = isNand ? "nand" : isNor ? "nor" : form === "SOP" ? "or" : "and";

  const railX0 = 72;
  const railX1 = 198;
  const invX = 282;
  const laneX0 = 450;
  const gateX = 780;
  const finalX = 1140;
  const yTop = 64;
  const railGapByVarCount = { 2:38, 3:42, 4:46 };
  const railGap = (railGapByVarCount[vars.length] || 46) + (implMode === "standard" ? 0 : 4);
  const maxLiteralLanes = Math.max(1, vars.length * 2);
  const laneGap = Math.max(34, Math.min(46, (gateX - laneX0 - 42) / Math.max(1, maxLiteralLanes - 1)));

  // Gate half-height grows with fan-in so input wires keep visible separation.
  const gateHeightForFanIn = (n) => Math.max(34, Math.min(76, Math.max(1, n) * 14 + 18));
  const finalHeightForFanIn = (n) => Math.max(44, Math.min(86, Math.max(1, n) * 12 + 26));
  // Anchor wires at the real visual input/output boundary for each gate shape.
  const gateInputX = (kind, x) => (kind === "or" || kind === "nor") ? orGateInputX(x) : x + 1;
  const andOutCustom = (x, h, bubble=false, w=56) => andGateOutputX(x, h, bubble, w);
  const orOutCustom = (x, bubble=false) => orGateOutputX(x, bubble);
  const gateOutX = (kind, x, h) => {
    if (kind === "or" || kind === "nor") return orOutCustom(x, kind === "nor");
    if (kind === "nand") return andOutCustom(x, h, true, 56);
    return andOutCustom(x, h, false, 56);
  };

  const railY = {};
  vars.forEach((v, i) => { railY[v] = yTop + i * railGap; });

  const litKey = t => t.inv ? `${t.var}'` : t.var;
  const usedRaw = new Set(), usedInv = new Set(), usedVars = new Set();
  termsList.forEach(ts => ts.forEach(t => {
    usedVars.add(t.var);
    if (t.inv) usedInv.add(t.var); else usedRaw.add(t.var);
  }));

  const usedLits = [];
  vars.forEach(v => {
    if (usedRaw.has(v)) usedLits.push(v);
    if (usedInv.has(v)) usedLits.push(`${v}'`);
  });
  const laneX = {};
  usedLits.forEach((lit, i) => { laneX[lit] = laneX0 + i * laneGap; });

  const termGateHeights = termsList.map(ts => gateHeightForFanIn(Math.max(ts.length, 1)));
  const maxTermH = Math.max(...termGateHeights, 30);
  const termGap = Math.max(104, maxTermH * 2 + 46);
  const termY0 = yTop + vars.length * railGap + (usedInv.size ? 122 : 98);
  const termYs = termsList.map((_, i) => termY0 + i * termGap);
  const rawFinalY = (termYs[0] + termYs[termYs.length - 1]) / 2;
  const finalY = Number.isFinite(rawFinalY) ? rawFinalY : termY0;
  const finalGateH = finalHeightForFanIn(Math.max(termCount, 1));
  const finalOut = gateOutX(finalKind, finalX, finalGateH);
  const outXpos = finalOut + 94;
  const maxTermY = termYs.every(Number.isFinite) ? Math.max(...termYs) : termY0;
  const H = Math.max(440, maxTermY + maxTermH * 2 + 150, finalY + finalGateH * 2 + 150);
  const W = outXpos + 190;

  const norm = n => Math.round(n * 10) / 10;
  const pKey = (x,y) => `${norm(x)},${norm(y)}`;
  const compactTermText = (text, max=20) => text.length > max ? `${text.slice(0, max - 3)}...` : text;

  const pins = new Map();
  const routes = [];
  const decorativeSegs = [];
  const gates = [];
  const labels = [];
  const outputLayer = [];
  const dotCandidates = [];
  const forbiddenDots = new Set();

  const addPin = (id, x, y, net, kind="junction") => {
    if (![x,y].every(Number.isFinite) || net == null) return null;
    const pin = { id, x, y, net, kind };
    pins.set(id, pin);
    if (kind === "gateIn" || kind === "gateOut" || kind === "out") forbiddenDots.add(pKey(x,y));
    return pin;
  };
  const addDotCandidate = (pinId, role="tap") => {
    const p = pins.get(pinId);
    if (p) dotCandidates.push({ x:p.x, y:p.y, net:p.net, role, pinId });
  };
  const samePoint = (a, b) => a && b && Math.abs(a.x-b.x) < 0.4 && Math.abs(a.y-b.y) < 0.4;
  const isCollinear = (a, b, c) => {
    if (!a || !b || !c) return false;
    return (Math.abs(a.x-b.x) < 0.4 && Math.abs(b.x-c.x) < 0.4) ||
           (Math.abs(a.y-b.y) < 0.4 && Math.abs(b.y-c.y) < 0.4);
  };
  const compressPolyline = (pts) => {
    const clean = [];
    pts.forEach(p => {
      if (!p || ![p.x,p.y].every(Number.isFinite)) return;
      if (clean.length && samePoint(clean[clean.length-1], p)) return;
      clean.push(p);
    });
    let changed = true;
    while (changed) {
      changed = false;
      for (let i=1; i<clean.length-1; i++) {
        if (isCollinear(clean[i-1], clean[i], clean[i+1])) {
          clean.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return clean;
  };
  const connect = (key, fromId, toId, via=[], role="wire") => {
    const from = pins.get(fromId), to = pins.get(toId);
    if (!from || !to || from.net !== to.net) return;
    const net = from.net;
    const rawPts = [from, ...via.map((pt, i) => ({ id:`${key}_via_${i}`, x:pt[0], y:pt[1], net, kind:"via" })), to];
    const pts = compressPolyline(rawPts);
    if (pts.length < 2) return;
    if (!samePoint(pts[0], from) || !samePoint(pts[pts.length-1], to)) return;
    // A route is the atomic object. Segments are only a render/validation view
    // of this complete pin-to-pin polyline, so helper stubs cannot exist alone.
    routes.push({ key, net, role, pts, from:fromId, to:toId, stroke:C, width:SW });
  };
  const addDecorativeSeg = (key, x1, y1, x2, y2, stroke="#cbd5e1", width=1.1) => {
    decorativeSegs.push({ key, x1, y1, x2, y2, stroke, width });
  };

  const pinPlan = [];
  const taps = {};
  usedLits.forEach(l => { taps[l] = []; });
  termsList.forEach((terms, gi) => {
    const gy = termYs[gi];
    const h = termGateHeights[gi];
    const rawPitch = terms.length <= 1 ? 0 : Math.min(26, Math.max(14, (h * 1.52) / Math.max(1, terms.length - 1)));
    const rawSpread = terms.length <= 1 ? 0 : rawPitch * (terms.length - 1);
    const spread = terms.length <= 1 ? 0 : Math.min(rawSpread, h * 1.8);
    const pitch = terms.length <= 1 ? 0 : Math.min(rawPitch, spread / Math.max(1, terms.length - 1));
    terms.forEach((t, ti) => {
      const py = terms.length === 1 ? gy : gy - spread/2 + ti * pitch;
      const lit = litKey(t);
      pinPlan.push({ gi, ti, lit, py });
      taps[lit].push({ gi, ti, y: py });
    });
  });

  // Inputs, branch pins, and inverter pins.
  vars.forEach(v => {
    const y = railY[v];
    const active = usedVars.has(v);
    labels.push(<text key={`lbl_${v}`} x={railX0-14} y={y+5} textAnchor="end" fontSize="13.5" fontWeight="800" fontFamily="'Courier New',monospace" fill={active ? "#1e293b" : "#94a3b8"}>{v}</text>);
    if (!active) {
      addDecorativeSeg(`rail_inactive_${v}`, railX0, y, railX1-18, y);
      return;
    }

    addPin(`src_${v}`, railX0, y, v, "source");
    addPin(`branch_${v}`, railX1, y, v, "junction");
    connect(`rail_${v}`, `src_${v}`, `branch_${v}`, [], "rail");

    if (usedRaw.has(v)) {
      const lit = v;
      const lx = laneX[lit];
      addPin(`lane_src_${lit}`, lx, y, lit, "junction");
      connect(`raw_entry_${v}`, `branch_${v}`, `lane_src_${lit}`, [], "entry");
      labels.push(<text key={`lane_lbl_${lit}`} x={lx} y={termY0-54} textAnchor="middle" fontSize="10" fontWeight="850" fontFamily="'Courier New',monospace" fill="#1e293b">{lit}</text>);
    }

    if (usedInv.has(v)) {
      const iy = y + (implMode === "standard" ? 22 : 26);
      addPin(`inv_in_${v}`, invX, iy, v, "gateIn");
      connect(`inv_feed_${v}`, `branch_${v}`, `inv_in_${v}`, [[railX1, iy]], "feed");
      if (isNand) gates.push(<AndGate key={`inv_${v}`} x={invX} y={iy} w={48} h={18} label="" bubble />);
      else if (isNor) gates.push(<OrGate key={`inv_${v}`} x={invX} y={iy} h={15} label="" bubble />);
      else gates.push(<NotGate key={`inv_${v}`} x={invX} y={iy} label="" />);

      const lit = `${v}'`;
      const invOut = isNand ? andOutCustom(invX, 18, true, 48) : isNor ? orOutCustom(invX, true) : notGateOutputX(invX);
      addPin(`inv_out_${v}`, invOut, iy, lit, "source");
      addPin(`lane_src_${lit}`, laneX[lit], iy, lit, "junction");
      connect(`inv_out_wire_${v}`, `inv_out_${v}`, `lane_src_${lit}`, [], "entry");
      labels.push(<text key={`lane_lbl_${lit}`} x={laneX[lit]} y={termY0-54} textAnchor="middle" fontSize="9.6" fontWeight="900" fontFamily="'Courier New',monospace" fill="#92400e">{lit}</text>);
    }

    if (usedRaw.has(v) && usedInv.has(v)) addDotCandidate(`branch_${v}`, "fanout");
  });

  // Literal lane trunks are built only between real pins: lane source <-> taps.
  usedLits.forEach(lit => {
    const lx = laneX[lit];
    const laneSource = pins.get(`lane_src_${lit}`);
    if (!laneSource) return;
    const nodes = [{ id:`lane_src_${lit}`, y:laneSource.y }];
    (taps[lit] || []).forEach((t, i) => {
      const id = `tap_${lit}_${t.gi}_${t.ti}`;
      addPin(id, lx, t.y, lit, "junction");
      nodes.push({ id, y:t.y });
    });
    nodes.sort((a,b)=>a.y-b.y);
    for (let i=0; i<nodes.length-1; i++) connect(`trunk_${lit}_${i}`, nodes[i].id, nodes[i+1].id, [], "trunk");
    if ((taps[lit] || []).length > 1) (taps[lit] || []).forEach(t => addDotCandidate(`tap_${lit}_${t.gi}_${t.ti}`, "tap"));
  });

  // Term gate inputs and term output pins.
  termsList.forEach((terms, gi) => {
    const gy = termYs[gi];
    const h = termGateHeights[gi];
    const inputX = gateInputX(termKind, gateX);
    const pinItems = pinPlan.filter(p => p.gi === gi);

    pinItems.forEach((p, localIdx) => {
      const tapId = `tap_${p.lit}_${gi}_${p.ti}`;
      const pinId = `term_in_${gi}_${p.ti}`;
      addPin(pinId, inputX, p.py, p.lit, "gateIn");
      connect(`term_input_${gi}_${p.ti}`, tapId, pinId, [], "tap");
    });

    if (terms.length === 1 && implMode === "standard") {
      // Pass-through term: still expose a real output pin for routing.
    } else if (termKind === "nand") gates.push(<AndGate key={`term_${gi}`} x={gateX} y={gy} w={56} h={h} label="" bubble />);
    else if (termKind === "nor") gates.push(<OrGate key={`term_${gi}`} x={gateX} y={gy} h={h} label="" bubble />);
    else if (termKind === "and") gates.push(<AndGate key={`term_${gi}`} x={gateX} y={gy} w={56} h={h} label="AND" />);
    else gates.push(<OrGate key={`term_${gi}`} x={gateX} y={gy} h={h} label="OR" />);

    const isStandardPassThroughTerm = terms.length === 1 && implMode === "standard";
    const termText = form === "SOP" ? sopTermExpr(terms) : posTermExpr(terms);
    if (!isStandardPassThroughTerm) {
      labels.push(<text key={`term_lbl_${gi}`} x={gateX} y={gy-h-Math.min(12, termGap * 0.15)} textAnchor="start" fontSize="7.5" fontFamily="'Courier New',monospace" fontWeight="800" fill={GROUP_COLORS[gi%GROUP_COLORS.length]}>
        <title>{termText}</title>{compactTermText(termText)}
      </text>);
    }

    const finalInputX = gateInputX(finalKind, finalX);
    const fPitch = termCount <= 1 ? 0 : Math.min(20, Math.max(12, (finalGateH * 1.45) / Math.max(1, termCount - 1)));
    const fSpread = termCount <= 1 ? 0 : fPitch * (termCount - 1);
    const fPinY = termCount === 1 ? finalY : finalY - fSpread/2 + gi * fPitch;
    const finalPinId = `final_in_${gi}`;
    const rawMidX = finalX - 112 - Math.min(gi, termCount-1-gi) * 22;
    const minMidX = gateOutX(termKind, gateX, h) + 24;
    const midX = Math.max(rawMidX, minMidX);

    const termOut = gateOutX(termKind, gateX, h) + WIRE_GAP;
    if (isStandardPassThroughTerm) {
      const literalNet = pinItems[0]?.lit;
      const termInputId = `term_in_${gi}_0`;
      if (termCount > 1 && literalNet) {
        const passMidX = Math.max(rawMidX, inputX + 28);
        addPin(finalPinId, finalInputX, fPinY, literalNet, "gateIn");
        connect(`literal_to_final_${gi}`, termInputId, finalPinId, [[passMidX, gy], [passMidX, fPinY]], "route");
      }
    } else if (termCount === 1 && implMode === "standard") {
      addPin(`term_out_${gi}`, termOut, gy, "F", "source");
    } else {
      const termNet = `T${gi}`;
      addPin(`term_out_${gi}`, termOut, gy, termNet, "source");
      addPin(finalPinId, finalInputX, fPinY, termNet, "gateIn");
      connect(`term_to_final_${gi}`, `term_out_${gi}`, finalPinId, [[midX, gy], [midX, fPinY]], "route");
    }
  });

  const finalYForOutput = termCount > 1 || implMode !== "standard" ? finalY : termYs[0];
  if (termCount > 1 || implMode !== "standard") {
    if (finalKind === "nand") gates.push(<AndGate key="final" x={finalX} y={finalY} w={58} h={finalGateH} label="" bubble />);
    else if (finalKind === "nor") gates.push(<OrGate key="final" x={finalX} y={finalY} h={finalGateH} label="" bubble />);
    else if (finalKind === "or") gates.push(<OrGate key="final" x={finalX} y={finalY} h={finalGateH} label="OR" />);
    else gates.push(<AndGate key="final" x={finalX} y={finalY} w={58} h={finalGateH} label="AND" />);
    addPin("final_out", finalOut + WIRE_GAP, finalY, "F", "source");
    addPin("F_out", outXpos, finalY, "F", "out");
    connect("final_to_F", "final_out", "F_out", [], "output");
  } else {
    const onlyTerm = termsList[0] || [];
    if (onlyTerm.length === 1) {
      const literalNet = litKey(onlyTerm[0]);
      addPin("F_out", outXpos, finalYForOutput, literalNet, "out");
      connect("single_literal_to_F", "term_in_0_0", "F_out", [], "output");
    } else {
      addPin("F_out", outXpos, finalYForOutput, "F", "out");
      connect("single_to_F", "term_out_0", "F_out", [], "output");
    }
  }
  outputLayer.push(<circle key="out_dot_halo" cx={outXpos} cy={finalYForOutput} r="7.0" fill="#f8f9ff"/>);
  outputLayer.push(<circle key="out_dot" cx={outXpos} cy={finalYForOutput} r="5.2" fill={C}/>);
  outputLayer.push(<text key="out_lbl" x={outXpos+18} y={finalYForOutput+5} fontSize="16" fontWeight="900" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>);

  // Convert complete routes into renderable segments only after every route has a
  // valid first pin and last pin. Collinear helper points have already been removed.
  const segs = [];
  routes.forEach(route => {
    const pts = route.pts || [];
    if (pts.length < 2) return;
    const fromPin = pins.get(route.from), toPin = pins.get(route.to);
    if (!fromPin || !toPin || route.net !== fromPin.net || route.net !== toPin.net) return;
    if (!samePoint(pts[0], fromPin) || !samePoint(pts[pts.length-1], toPin)) return;
    for (let i=0; i<pts.length-1; i++) {
      const a = pts[i], b = pts[i+1];
      if (Math.abs(a.x-b.x) < 0.4 && Math.abs(a.y-b.y) < 0.4) continue;
      segs.push({ key:`${route.key}_${i}`, x1:a.x, y1:a.y, x2:b.x, y2:b.y, net:route.net, role:route.role, stroke:route.stroke, width:route.width, routeKey:route.key });
    }
  });

  // Deduplicate and split same-net T junctions. Different-net crossings are not connections.
  const canonicalSegKey = s => {
    const ax = norm(s.x1), ay = norm(s.y1), bx = norm(s.x2), by = norm(s.y2);
    const aFirst = ax < bx || (ax === bx && ay <= by);
    const a = `${ax},${ay}`, b = `${bx},${by}`;
    return s.net + "|" + (aFirst ? `${a}|${b}` : `${b}|${a}`);
  };
  const dedup = [];
  const seen = new Set();
  segs.forEach(s => {
    const len = Math.abs(s.x1-s.x2) + Math.abs(s.y1-s.y2);
    if (len < 1) return;
    const k = canonicalSegKey(s);
    if (seen.has(k)) return;
    seen.add(k);
    dedup.push(s);
  });

  const splitSegments = [];
  const byNet = new Map();
  dedup.forEach(s => { if (!byNet.has(s.net)) byNet.set(s.net, []); byNet.get(s.net).push(s); });
  byNet.forEach((list) => {
    list.forEach(s => {
      if (Math.abs(s.x1-s.x2) < 0.4) {
        const x = s.x1;
        const yMin = Math.min(s.y1,s.y2), yMax = Math.max(s.y1,s.y2);
        const cuts = [s.y1, s.y2];
        list.forEach(o => {
          if (o === s || Math.abs(o.y1-o.y2) >= 0.4) return;
          const oxMin = Math.min(o.x1,o.x2), oxMax = Math.max(o.x1,o.x2);
          if (x >= oxMin-0.4 && x <= oxMax+0.4 && o.y1 >= yMin-0.4 && o.y1 <= yMax+0.4) cuts.push(o.y1);
        });
        const ys = [...new Set(cuts.map(norm))].sort((a,b)=>a-b);
        for (let i=0;i<ys.length-1;i++) splitSegments.push({...s, key:`${s.key}_s${i}`, y1:ys[i], y2:ys[i+1]});
      } else if (Math.abs(s.y1-s.y2) < 0.4) {
        const y = s.y1;
        const xMin = Math.min(s.x1,s.x2), xMax = Math.max(s.x1,s.x2);
        const cuts = [s.x1, s.x2];
        list.forEach(o => {
          if (o === s || Math.abs(o.x1-o.x2) >= 0.4) return;
          const oyMin = Math.min(o.y1,o.y2), oyMax = Math.max(o.y1,o.y2);
          if (y >= oyMin-0.4 && y <= oyMax+0.4 && o.x1 >= xMin-0.4 && o.x1 <= xMax+0.4) cuts.push(o.x1);
        });
        const xs = [...new Set(cuts.map(norm))].sort((a,b)=>a-b);
        for (let i=0;i<xs.length-1;i++) splitSegments.push({...s, key:`${s.key}_s${i}`, x1:xs[i], x2:xs[i+1]});
      } else splitSegments.push(s);
    });
  });

  const sourceKeysByNet = new Map();
  const sinkKeysByNet = new Map();
  pins.forEach(p => {
    if (p.kind === "source") {
      if (!sourceKeysByNet.has(p.net)) sourceKeysByNet.set(p.net, new Set());
      sourceKeysByNet.get(p.net).add(pKey(p.x,p.y));
    }
    if (p.kind === "gateIn" || p.kind === "out") {
      if (!sinkKeysByNet.has(p.net)) sinkKeysByNet.set(p.net, new Set());
      sinkKeysByNet.get(p.net).add(pKey(p.x,p.y));
    }
  });

  const componentClean = [];
  const splitByNet = new Map();
  splitSegments.forEach(s => { if (!splitByNet.has(s.net)) splitByNet.set(s.net, []); splitByNet.get(s.net).push(s); });
  splitByNet.forEach((list, net) => {
    const adj = new Map();
    const addEdge = (a,b,idx) => {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push({to:b,idx}); adj.get(b).push({to:a,idx});
    };
    list.forEach((s,i)=>addEdge(pKey(s.x1,s.y1), pKey(s.x2,s.y2), i));
    const visited = new Set();
    [...adj.keys()].forEach(start => {
      if (visited.has(start)) return;
      const stack=[start], nodes=[], edgeIds=new Set();
      visited.add(start);
      while(stack.length){
        const n=stack.pop(); nodes.push(n);
        (adj.get(n)||[]).forEach(e=>{ edgeIds.add(e.idx); if(!visited.has(e.to)){ visited.add(e.to); stack.push(e.to); } });
      }
      const srcs = sourceKeysByNet.get(net) || new Set();
      const sinks = sinkKeysByNet.get(net) || new Set();
      const hasSource = nodes.some(n => srcs.has(n));
      const hasSink = nodes.some(n => sinks.has(n));
      if (hasSource && hasSink) [...edgeIds].forEach(i=>componentClean.push(list[i]));
    });
  });

  const gridDots = makeGridDots(W + CIRCUIT_PAD, H + CIRCUIT_PAD, "stable_grid");

  const wires = [
    ...decorativeSegs.map((s,i)=><line key={`${s.key}_${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.stroke} strokeWidth={s.width} strokeLinecap="square"/>),
    ...componentClean.map((s,i)=><line key={`${s.key}_${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.stroke} strokeWidth={s.width} strokeLinecap="square"/>),
  ];

  // Dot pass runs only after floating cleanup.
  const degreeByNetPoint = new Map();
  componentClean.forEach(s => {
    const a = `${s.net}|${pKey(s.x1,s.y1)}`;
    const b = `${s.net}|${pKey(s.x2,s.y2)}`;
    degreeByNetPoint.set(a, (degreeByNetPoint.get(a)||0)+1);
    degreeByNetPoint.set(b, (degreeByNetPoint.get(b)||0)+1);
  });
  const dotMap = new Map();
  dotCandidates.forEach(d => {
    const point = pKey(d.x,d.y);
    if (forbiddenDots.has(point)) return;
    if (d.role !== "fanout" && d.role !== "tap") return;
    const deg = degreeByNetPoint.get(`${d.net}|${point}`) || 0;
    if (deg < 3) return;
    dotMap.set(`${d.net}|${point}`, d);
  });
  const dotHalos = [...dotMap.values()].map((d,i)=><circle key={`dot_halo_${i}_${d.net}_${pKey(d.x,d.y)}`} cx={d.x} cy={d.y} r="5.4" fill="#f8f9ff"/>);
  const dots = [...dotMap.values()].map((d,i)=><circle key={`dot_${i}_${d.net}_${pKey(d.x,d.y)}`} cx={d.x} cy={d.y} r="3.4" fill={C}/>);

  return <svg viewBox={`0 0 ${W + CIRCUIT_PAD} ${H + CIRCUIT_PAD}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W+CIRCUIT_PAD} height={H+CIRCUIT_PAD} fill="#f8f9ff" />
    {gridDots}{wires}{gates}{dotHalos}{dots}{labels}{outputLayer}
  </svg>;
}


function CompactTermCircuit({ terms, form="SOP" }) {
  const W = 560, H = Math.max(230, 80 + terms.length * 50), C = "#111", SW = 1.8;
  const gateX = 290;
  const yMid = H / 2;
  const inputGap = terms.length <= 2 ? 34 : terms.length === 3 ? 30 : 26;
  const ys = terms.map((_,i)=> yMid + (i-(terms.length-1)/2)*inputGap);
  const x0 = 78;
  const notX = 160;
  const inputEnd = gateX - 18;
  const gateKind = form === "SOP" ? "and" : "or";
  const gateLabel = form === "SOP" ? "AND" : "OR";
  const gateOut = gateKind === "and" ? andGateOutputX(gateX, AND_H, false, AND_W) : orGateOutputX(gateX, false);
  const outEnd = Math.min(W-74, gateOut + 82);

  const gridDots = makeGridDots(W, H, "compact_grid");

  const wires=[]; const gates=[]; const labels=[];
  terms.forEach((t,i)=>{
    const y = ys[i];
    labels.push(<text key={`lbl_${i}`} x={x0-14} y={y+5} textAnchor="end" fontSize="14" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">{t.var}</text>);
    if (t.inv) {
      wires.push(<line key={`w1_${i}`} x1={x0} y1={y} x2={notX} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      gates.push(<NotGate key={`not_${i}`} x={notX} y={y} label="" />);
      wires.push(<line key={`w2_${i}`} x1={notGateOutputX(notX)} y1={y} x2={inputEnd} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      labels.push(<text key={`nl_${i}`} x={notGateOutputX(notX)+4} y={y-8} fontSize="11" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{t.var+"'"}</text>);
    } else {
      wires.push(<line key={`w_${i}`} x1={x0} y1={y} x2={inputEnd} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    }
  });

  const compactOrH = Math.max(24, ys.length > 1 ? (ys[ys.length-1] - ys[0]) / 2 + 4 : 24);
  if (gateKind === "and") gates.push(<AndGate key="gate" x={gateX} y={yMid} label={gateLabel} />);
  else gates.push(<OrGate key="gate" x={gateX} y={yMid} h={compactOrH} label={gateLabel} />);

  wires.push(<line key="out" x1={gateOut} y1={yMid} x2={outEnd} y2={yMid} stroke={C} strokeWidth={SW} strokeLinecap="square" />);

  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{gridDots}
    {wires}{gates}{labels}
    <circle cx={outEnd} cy={yMid} r="4.8" fill={C}/>
    <text x={outEnd+18} y={yMid+5} fontSize="17" fontWeight="900" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>
  </svg>;
}

function SingleLiteralCircuit({ term, vars=ALL_VARS }) {
  const W = 430, H = 190, C = "#111", SW = 1.8;
  const y = 94, x0 = 74, xInv = 150, xOut = 340;
  const gridDots = makeGridDots(W, H, "single_grid");
  const label = literalText(term);
  if (!term.inv) {
    return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
      <rect width={W} height={H} fill="#f8f9ff" />{gridDots}
      <text x={x0-18} y={y+5} textAnchor="end" fontSize="15" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">{term.var}</text>
      <line x1={x0} y1={y} x2={xOut} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />
      <circle cx={x0} cy={y} r="4.2" fill={C}/><circle cx={xOut} cy={y} r="4.8" fill={C}/>
      <text x={xOut+10} y={y+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>
    </svg>;
  }
  const invOut = notGateOutputX(xInv);
  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{gridDots}
    <text x={x0-18} y={y+5} textAnchor="end" fontSize="15" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">{term.var}</text>
    <line x1={x0} y1={y} x2={xInv} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />
    <NotGate x={xInv} y={y} label="" />
    <line x1={invOut} y1={y} x2={xOut} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />
    <circle cx={x0} cy={y} r="4.2" fill={C}/><circle cx={xOut} cy={y} r="4.8" fill={C}/>
    <text x={xOut+10} y={y+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>
    <text x={notGateOutputX(xInv)+14} y={y-12} fontSize="11" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{label}</text>
  </svg>;
}

function ConstCircuit({ value }) {
  const W=520,H=180,y=90,x1=120,x2=390,C="#111",SW=1.7;
  const safeValue = value ? 1 : 0;
  const gridDots = makeGridDots(W, H, "const_grid");
  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{gridDots}
    <text x={x1-18} y={y+5} textAnchor="end" fontSize="15" fontWeight="800" fontFamily="'Courier New',monospace" fill="#475569">{safeValue?"VCC":"GND"}</text>
    <line x1={x1} y1={y} x2={x2} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />
    <circle cx={x2} cy={y} r="4.8" fill={C}/>
    <text x={x2+10} y={y+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F = {safeValue}</text>
  </svg>;
}

function XorCircuit({ xorInfo }) {
  const C="#111", SW=1.8;
  const used = xorInfo.used && xorInfo.used.length ? xorInfo.used : ["A","B"];
  const inputCount = Math.max(2, used.length || 0);
  const W = Math.max(560, 520 + Math.max(0, inputCount-2) * 34);
  const H = Math.max(210, 150 + inputCount * 30);
  const x0=92;
  const xGate=285;
  const yMid=H/2;
  const inputGap = inputCount <= 2 ? 32 : 26;
  const inputYs = used.map((_, i)=> yMid + (i-(inputCount-1)/2)*inputGap);
  const inputEnd=xGate-38;
  const bubble = !!xorInfo.invert;
  const label = bubble ? "XNOR" : (inputCount > 2 ? "PARITY" : "XOR");
  const gateOut = orGateOutputX(xGate, bubble);
  const outEnd = W-64;

  const gridDots = makeGridDots(W, H, "xor_grid");

  // For 3+ input parity, render a readable functional block rather than a
  // misleading two-input XOR symbol. This keeps the circuit truth semantics
  // correct without implying a physical two-pin XOR gate.
  if (inputCount > 2) {
    const blockX = xGate;
    const blockY = yMid - Math.max(38, inputCount*13);
    const blockH = Math.max(76, inputCount*26);
    const blockW = 122;
    return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
      <rect width={W} height={H} fill="#f8f9ff" />{gridDots}
      {used.map((v,i)=><g key={`in_${v}`}>
        <text x={x0-14} y={inputYs[i]+5} textAnchor="end" fontSize="14" fontWeight="800" fontFamily="'Courier New',monospace">{v}</text>
        <line x1={x0} y1={inputYs[i]} x2={blockX} y2={inputYs[i]} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
      </g>)}
      <rect x={blockX} y={blockY} width={blockW} height={blockH} rx="16" fill="#fff" stroke="#111" strokeWidth="1.9"/>
      {bubble && <circle cx={blockX+blockW+OR_BUBBLE_R+1} cy={yMid} r="4.8" fill="#fff" stroke="#111" strokeWidth="1.9" />}
      <text x={blockX+blockW/2} y={yMid-4} textAnchor="middle" fontSize="12" fontFamily="Arial,sans-serif" fontWeight="900">{label}</text>
      <text x={blockX+blockW/2} y={yMid+14} textAnchor="middle" fontSize="9.5" fontFamily="'Courier New',monospace" fontWeight="800">{used.join(" ⊕ ")}</text>
      <line x1={blockX+blockW+(bubble?Math.ceil(OR_BUBBLE_R*2+1):0)} y1={yMid} x2={outEnd} y2={yMid} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
      <circle cx={outEnd} cy={yMid} r="4.8" fill={C}/>
      <text x={outEnd+18} y={yMid+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace">F</text>
    </svg>;
  }

  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{gridDots}

    {used.map((v,i)=><g key={`in_${v}`}>
      <text x={x0-14} y={inputYs[i]+5} textAnchor="end" fontSize="14" fontWeight="800" fontFamily="'Courier New',monospace">{v}</text>
      <line x1={x0} y1={inputYs[i]} x2={inputEnd} y2={inputYs[i]} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
    </g>)}

    <XorGate x={xGate} y={yMid} label={label} bubble={bubble} />

    <line x1={gateOut} y1={yMid} x2={outEnd} y2={yMid} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
    <circle cx={outEnd} cy={yMid} r="4.8" fill={C}/>
    <text x={outEnd+18} y={yMid+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace">F</text>
  </svg>;
}

// ═══════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════
export default function KarnaughMapApp() {
  const [varCount, setVarCount] = useState(4);
  const cfg = useMemo(() => getKmapConfig(varCount), [varCount]);
  const vars = cfg.vars;
  const [cells, setCells] = useState(Array(cfg.total).fill(0));
  const [tab, setTab] = useState("kmap");
  const [optMode, setOptMode] = useState("sop"); // sop | pos | auto
  const [implMode, setImplMode] = useState("standard"); // standard | nand | nor
  const [detectXor, setDetectXor] = useState(true);
  const [editMode, setEditMode] = useState("cell"); // cell | row | col | all
  const [toast, setToast] = useState("");
  const [activePreset, setActivePreset] = useState(null);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const exampleWrapRef = useRef(null);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 1200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onPointerDown = (e) => {
      if (!exampleWrapRef.current) return;
      if (e.target instanceof Node && !exampleWrapRef.current.contains(e.target)) setExampleOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const buildPresetCells = useCallback((kind, count) => {
    const total = 1 << count;
    const next = Array(total).fill(0);

    for (let m=0; m<total; m++) {
      const a = bitOf(m, 0, count);
      const b = count >= 2 ? bitOf(m, 1, count) : 0;
      const c = count >= 3 ? bitOf(m, 2, count) : 0;

      if (kind === "xor") next[m] = a ^ b;
      else if (kind === "xnor") next[m] = (a ^ b) ? 0 : 1;
      else if (kind === "majority") next[m] = count >= 3 ? ((a + b + c) >= 2 ? 1 : 0) : (a & b);
      else if (kind === "half_sum") next[m] = a ^ b;
      else if (kind === "half_carry") next[m] = a & b;
      else if (kind === "full_sum") next[m] = count >= 3 ? (a ^ b ^ c) : (a ^ b);
      else if (kind === "full_carry") next[m] = count >= 3 ? ((a & b) | (a & c) | (b & c)) : (a & b);
      else if (kind === "mux") next[m] = count >= 3 ? (c ? b : a) : a;
    }
    return { cells: next, varCount: count };
  }, []);

  const changeVarCount = useCallback((nextCount) => {
    setSelectedGroup(null);
    setVarCount(nextCount);
    if (activePreset) {
      const built = buildPresetCells(activePreset, nextCount);
      setCells(built.cells);
    } else {
      setCells(Array(1 << nextCount).fill(0));
    }
  }, [activePreset, buildPresetCells]);

  const normalizedCells = useMemo(() => {
    const total = cfg.total;
    return Array.from({ length: total }, (_, i) => cells[i] ?? 0);
  }, [cells, cfg.total]);
  const dimensionKey = `${varCount}_${cfg.total}_${normalizedCells.length}`;
  const plans = useMemo(()=>buildPlans(normalizedCells, vars), [normalizedCells, vars]);

  // K-map and Circuit are separated:
  // - K-map always follows Optimization (Auto/SOP/POS) with Standard expression semantics.
  // - Circuit follows Implementation (Standard/NAND/NOR); NAND uses SOP, NOR uses POS internally.
  const kmapPlan = useMemo(()=>choosePlan(plans, optMode, "standard"), [plans, optMode]);
  const circuitPlan = useMemo(()=>choosePlan(plans, optMode, implMode), [plans, optMode, implMode]);
  const activePlan = tab === "circuit" ? circuitPlan : kmapPlan;
  const activeImpl = tab === "circuit" ? implMode : "standard";
  const xorRecommendationEnabled = implMode === "standard" && optMode === "auto" && detectXor;
  const circuitUsesXor = tab === "circuit" && xorRecommendationEnabled && !!plans.xor;

  const reco = useMemo(()=>recommendationSummary(plans, xorRecommendationEnabled), [plans, xorRecommendationEnabled]);
  const activeMetrics = circuitUsesXor
    ? { gates:1, literals:plans.xor.used.length, depth:1, inverters:0 }
    : estimateMetrics(activePlan, activeImpl);
  const activeCost = circuitUsesXor ? Math.max(2, plans.xor.used.length) : implementationCost(activePlan, activeImpl);

  const mintermAt = useCallback((row, col) => cellToMinterm(row, col, cfg), [cfg]);
  const cycleCell = useCallback((m) => { setActivePreset(null); setCells(p => { const n=[...p]; n[m]=((n[m] ?? 0)+1)%3; return n; }); }, []);
  const fillAll = (val) => { setActivePreset(null); setCells(Array(cfg.total).fill(val)); };
  const fillRow = (row, val) => { setActivePreset(null); setCells(p => { const n=[...p]; cfg.colGray.forEach((_,col)=>{ n[cellToMinterm(row,col,cfg)] = val; }); return n; }); };
  const fillCol = (col, val) => { setActivePreset(null); setCells(p => { const n=[...p]; cfg.rowGray.forEach((_,row)=>{ n[cellToMinterm(row,col,cfg)] = val; }); return n; }); };
  const smartFillFromCell = (row, col) => {
    setSelectedGroup(null);
    const m = mintermAt(row, col);
    const next = ((normalizedCells[m] ?? 0) + 1) % 3;
    if (editMode === "cell") cycleCell(m);
    else if (editMode === "row") fillRow(row, next);
    else if (editMode === "col") fillCol(col, next);
    else if (editMode === "all") fillAll(next);
  };

  const showToast = useCallback((msg) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => {
      setToast("");
      toastTimerRef.current = null;
    }, 1200);
  }, []);


  const applyPreset = (kind) => {
    const built = buildPresetCells(kind, varCount);
    setCells(built.cells);
    setActivePreset(kind);
    showToast(`${kindLabel(kind)} example loaded`);
  };

  const clearMap = () => {
    setCells(Array(cfg.total).fill(0));
    setActivePreset(null);
    showToast("K-map cleared");
  };

  const cellSize = varCount === 2 ? 72 : 62;

  const detectedPattern = plans.xor ? (plans.xor.invert ? "XNOR Detected" : "XOR Detected") : "—";
  const implLabel = circuitUsesXor
    ? `${plans.xor.invert ? "XNOR" : "XOR"} Pattern · Standard`
    : `${activePlan.form} · ${activeImpl === "standard" ? "Standard" : activeImpl.toUpperCase()}`;
  const sopItems = coloredTermList(plans.sop.termsList, "SOP");
  const posItems = coloredTermList(plans.pos.termsList, "POS");
  const sopExprText = plans.sop.expr === "F = 0" || plans.sop.expr === "F = 1"
    ? plans.sop.expr.replace("F = ", "")
    : joinExprTerms(sopItems, " + ");
  const posExprText = plans.pos.expr === "F = 0" || plans.pos.expr === "F = 1"
    ? plans.pos.expr.replace("F = ", "")
    : joinExprTerms(posItems, " · ");

  const selectExpressionGroup = useCallback((form, key) => {
    setOptMode(form.toLowerCase());
    setSelectedGroup(prev => prev === key ? null : key);
  }, []);

  const renderExprLine = ({ title, form, items, expr, joiner, active }) => <div style={exprLine(active)}>
    <div style={exprLineHeader()}>
      <div style={exprLineTitle(active)}>{title}</div>
      <div style={exprLineHint()}>Group → Term</div>
    </div>
    <div style={exprGroupList()}>
      {items.length ? items.map((item, idx) => {
        const selected = selectedGroup === item.key;
        return <button
          key={item.key}
          data-group-control="1"
          onClick={()=>selectExpressionGroup(form, item.key)}
          style={exprGroupTermRow(item.color, selected)}
          title={`Tap to switch to ${form} and highlight this K-map group`}
        >
          <span style={exprGroupBadge(item.color)}>G{idx + 1}</span>
          <span style={{color:"#64748b",fontWeight:950}}>→</span>
          <span style={{fontFamily:"'Courier New',monospace",fontWeight:950,color:item.color,whiteSpace:"nowrap"}}>{item.text}</span>
        </button>;
      }) : <span style={{fontFamily:"'Courier New',monospace",fontWeight:900,color:"#0f172a"}}>{expr}</span>}
    </div>
    {items.length > 0 && <div style={exprResultLine()}>
      <span style={exprResultLabel()}>Result</span>
      <span style={exprResultText()}>{expr}</span>
    </div>}
  </div>;

  const renderResultCards = () => <div style={resultWrap()}>
    <div style={exprCard()}>
      <div style={cardLabel()}>EXPRESSIONS</div>
      {renderExprLine({ title:"SOP", form:"SOP", items:sopItems, expr:sopExprText, joiner:"+", active:activePlan.form === "SOP" })}
      {renderExprLine({ title:"POS", form:"POS", items:posItems, expr:posExprText, joiner:"·", active:activePlan.form === "POS" })}
    </div>
    <div style={recoCard()}>
      <div style={cardLabel()}>RESULT</div>

      <div style={resultSection()}>
        <span style={resultKey()}>Implementation</span>
        <span style={{...resultVal(),color:"#0f766e"}}>★ {implLabel}</span>
      </div>

      <div style={resultSection()}>
        <span style={resultKey()}>Pattern</span>
        <span style={{...resultVal(),color:plans.xor ? "#7c3aed" : "#94a3b8"}}>
          {plans.xor ? `✓ ${detectedPattern}` : "—"}
        </span>
      </div>

      <div style={resultSection()}>
        <span style={resultKey()}>Recommended</span>
        <span style={resultVal()}>{reco.best.name}</span>
      </div>

      <div style={resultSection()}>
        <span style={resultKey()}>Example</span>
        <span style={resultVal()}>{activePreset ? kindLabel(activePreset) : "—"}</span>
      </div>

      <div style={{fontSize:"0.68rem",fontWeight:850,color:"#475569",marginTop:6,lineHeight:1.35,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
        Gate {activeMetrics.gates} · Lit {activeMetrics.literals} · Depth {activeMetrics.depth} · Cost {activeCost}
      </div>
    </div>
  </div>;

  const renderKmapTable = () => {
    const labelW = 58;
    const labelH = 30;
    const gap = 6;
    const w = labelW + cfg.cols * cellSize + (cfg.cols - 1) * gap + 18;
    const h = labelH + cfg.rows * cellSize + (cfg.rows - 1) * gap + 18;

    const cellX = (col) => labelW + col * (cellSize + gap);
    const cellY = (row) => labelH + row * (cellSize + gap);

    const loopItems = kmapPlan.groups.flatMap((g, gi) => {
      const color = GROUP_COLORS[gi % GROUP_COLORS.length];
      const key = stableKeyForGroup(kmapPlan.form, gi);
      const selected = selectedGroup === key;
      const dim = selectedGroup && !selected;
      return kmapSvgGroupLoopRects(g, gi, cfg, cellX, cellY, cellSize).map(rect => ({...rect, color, groupKey:key, selected, dim}));
    });

    return <svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",maxWidth:w,height:"auto",display:"block",overflow:"visible"}}>
      <text x={labelW-8} y={20} textAnchor="end" fontSize="10.5" fontWeight="850" fill="#64748b">
        <tspan fill="#3b82f6">{cfg.rowLabel}</tspan><tspan>↓ </tspan><tspan fill="#16a34a">{cfg.colLabel}</tspan><tspan>→</tspan>
      </text>

      {cfg.colGray.map((cd,col)=><g key={`ch_${cd}`} onClick={()=>{ if (editMode === "col") fillCol(col, ((normalizedCells[mintermAt(0,col)] ?? 0) + 1) % 3); }} style={{cursor:editMode==="col"?"pointer":"default"}}>
        <rect x={cellX(col)} y={0} width={cellSize} height={24} rx={8} fill={editMode==="col" ? "#fff" : "transparent"} stroke={editMode==="col" ? "#16a34a" : "transparent"} strokeWidth="1.8" />
        <text x={cellX(col)+cellSize/2} y={16} textAnchor="middle" fontSize="12" fontWeight="950" fill="#16a34a">{cd}</text>
      </g>)}

      {cfg.rowGray.map((ab,row)=><g key={`rh_${ab}`} onClick={()=>{ if (editMode === "row") fillRow(row, ((normalizedCells[mintermAt(row,0)] ?? 0) + 1) % 3); }} style={{cursor:editMode==="row"?"pointer":"default"}}>
        <rect x={2} y={cellY(row)} width={46} height={cellSize} rx={8} fill={editMode==="row" ? "#fff" : "transparent"} stroke={editMode==="row" ? "#3b82f6" : "transparent"} strokeWidth="1.8" />
        <text x={25} y={cellY(row)+cellSize/2+4} textAnchor="middle" fontSize="12" fontWeight="950" fill="#3b82f6">{ab}</text>
      </g>)}

      {cfg.rowGray.map((_,row)=>cfg.colGray.map((__,col)=>{
        const m = mintermAt(row,col);
        const val = normalizedCells[m] ?? 0;
        const x = cellX(col);
        const y = cellY(row);
        return <g key={`cell_${row}_${col}`} onClick={()=>smartFillFromCell(row,col)} style={{cursor:"pointer"}}>
          <rect x={x} y={y} width={cellSize} height={cellSize} rx={8} fill={val===1?"#fff":val===2?"#fef9c3":"#f8fafc"} stroke="#cbd5e1" strokeWidth="1.5" />
          <text x={x+cellSize/2} y={y+cellSize/2+3} textAnchor="middle" fontSize="22" fontWeight="950" fill={val===1?"#1d4ed8":val===2?"#b45309":"#94a3b8"}>{val===2?"X":val}</text>
          <text x={x+cellSize/2} y={y+cellSize-9} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#94a3b8">m{m}</text>
        </g>;
      }))}

      {loopItems.map(item => <rect
        key={item.key}
        x={item.x}
        y={item.y}
        width={item.w}
        height={item.h}
        rx={14}
        ry={14}
        fill="none"
        stroke={item.color}
        strokeWidth={item.selected ? 4 : 3}
        opacity={item.dim ? 0.16 : item.selected ? 1 : 0.82}
        pointerEvents="none"
      />)}
    </svg>;
  };

  const exampleItems = [
    ["xor", "XOR"],
    ["xnor", "XNOR"],
    ["majority", "Majority"],
    ["half_sum", "Half Adder · Sum"],
    ["half_carry", "Half Adder · Carry"],
    ["full_sum", "Full Adder · Sum"],
    ["full_carry", "Full Adder · Carry"],
    ["mux", "2:1 MUX"],
  ];

  const renderExampleFloatingMenu = () => <div style={exampleMenu()}>
    {exampleItems.map(([id, label]) => {
      const active = activePreset === id;
      return <button key={id} onClick={()=>applyPreset(id)} style={exampleItem(active)}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
        {active && <span style={{fontSize:"0.68rem",fontWeight:950,flex:"0 0 auto"}}>✓</span>}
      </button>;
    })}
  </div>;

  const renderOptionsPanel = () => <div style={controlPanel()}>
    <div style={optionRows()}>
      <div style={optionRow()}>
        <CompactLine label="Vars"><PillGroup value={varCount} setValue={changeVarCount} items={[[2,"2"],[3,"3"],[4,"4"]]} fixed size="xs" /></CompactLine>
        <CompactLine label="Opt"><PillGroup value={optMode} setValue={setOptMode} items={[["sop","SOP"],["pos","POS"],["auto","Auto"]]} fixed size="sm" /></CompactLine>
      </div>

      <div style={optionRow()}>
        <CompactLine label="Mode"><PillGroup value={editMode} setValue={setEditMode} items={[["cell","Cell"],["row","Row"],["col","Col"],["all","All"]]} fixed size="md" /></CompactLine>
        <button onClick={clearMap} style={clearBtn()}>Clear</button>
      </div>

      <div style={optionRow()}>
        <CompactLine label="Impl"><PillGroup value={implMode} setValue={setImplMode} items={[["standard","Std"],["nand","NAND"],["nor","NOR"]]} fixed size="impl" /></CompactLine>
        <div style={{display:"flex",alignItems:"center",gap:4,flex:"0 0 auto"}}>
          <span style={{fontSize:"0.6rem",fontWeight:950,color:"#475569",letterSpacing:"0.03em"}}>XOR</span>
          <button onClick={()=>setDetectXor(v=>!v)} style={xorBtn(detectXor)}>{detectXor?"ON":"OFF"}</button>
        </div>
        <div ref={exampleWrapRef} style={{position:"relative",flex:"0 0 auto"}}>
          <button onClick={(e)=>{ e.stopPropagation(); setExampleOpen(v=>!v); }} style={exampleBtn(!!activePreset)}>
            Ex {exampleOpen ? "▲" : "▼"}
          </button>
          {exampleOpen && renderExampleFloatingMenu()}
        </div>
      </div>
    </div>
  </div>;

  if (showSplash) return <div style={{height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#0f172a",color:"#fff"}}>
      <div style={{fontSize:"2rem",fontWeight:900,letterSpacing:"0.04em"}}>Karnaugh Map Pro</div>
      <div style={{marginTop:10,fontSize:"0.9rem",opacity:0.8}}>K-Map Solver & Circuit Generator</div>
    </div>;

  return <div
    onPointerDownCapture={(e)=>{
      const target = e.target;
      const inGroupControl = target instanceof Element && target.closest('[data-group-control="1"]');
      if (selectedGroup && !inGroupControl) setSelectedGroup(null);
    }}
    style={{height:"100vh",display:"flex",flexDirection:"column",background:"#f1f5f9",fontFamily:"'Inter','Segoe UI',sans-serif",color:"#1e293b",overflow:"hidden"}}
  >
    <div style={appHeader()}>
      <div style={{width:122,flex:"0 0 122px",fontSize:"0.84rem",fontWeight:950,color:"#f8fafc",letterSpacing:"0.06em",whiteSpace:"nowrap"}}>K-MAP PRO</div>
      <div style={{flex:1,minWidth:0,display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
        <button onClick={()=>setTab("kmap")} style={mainTab(tab==="kmap")}>K-Map</button>
        <button onClick={()=>setTab("circuit")} style={mainTab(tab==="circuit")}>Circuit</button>
      </div>
    </div>

    <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0,overflow:"auto",scrollBehavior:"smooth"}}>
      {renderOptionsPanel()}

      <div style={{flex:"1 0 auto",display:"flex",flexDirection:"column",minHeight:0}}>
      {tab === "kmap" && <div style={{flex:"1 0 auto",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-start",padding:"16px 14px 12px",gap:10,minHeight:"calc(100vh - 132px)"}}>
        {renderKmapTable()}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center",maxWidth:620}}>{kmapPlan.termsList.map((t,i)=>{
          const key = stableKeyForGroup(kmapPlan.form, i);
          const selected = selectedGroup === key;
          const color = GROUP_COLORS[i%GROUP_COLORS.length];
          return <button key={key} data-group-control="1" onClick={()=>setSelectedGroup(selected ? null : key)} style={groupChip(color, selected)}>
            <span style={{width:8,height:8,borderRadius:2,display:"inline-block",background:color}}/>
            <span style={{fontWeight:800,fontFamily:"monospace",color}}>{kmapPlan.form==="SOP"?sopTermExpr(t):posTermExpr(t)}</span>
          </button>;
        })}</div>
        {renderResultCards()}
      </div>}

      {tab === "circuit" && <div style={{flex:"1 0 auto",padding:"10px 12px",display:"flex",flexDirection:"column",gap:8,minHeight:"calc(100vh - 132px)"}}>
        {implMode === "standard" && detectXor && plans.xor && circuitPlan.form !== "SOP" && <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,fontSize:"0.68rem",fontWeight:900,color:"#7c3aed",background:"#f5f3ff",border:"1px solid #ddd6fe",borderRadius:8,padding:"6px 8px"}}>
          <span>XOR detected · SOP view required</span>
          <button onClick={()=>setOptMode("sop")} style={{border:"1px solid #c4b5fd",borderRadius:7,background:"#fff",color:"#6d28d9",fontSize:"0.66rem",fontWeight:950,padding:"4px 7px",cursor:"pointer"}}>Switch to SOP</button>
        </div>}
        <div style={{minHeight:300,flex:"1 1 300px",background:"#fff",borderRadius:10,border:"1px solid #e2e8f0",boxShadow:"0 1px 8px rgba(0,0,0,0.06)",overflow:"hidden"}}>
          <CircuitDiagram key={`circuit_${dimensionKey}_${implMode}_${circuitPlan.form}_${circuitUsesXor ? "xor_" + (plans.xor?.used || []).join("_") : "logic"}`} plan={circuitPlan} implMode={implMode} xorInfo={plans.xor} xorEnabled={circuitUsesXor} />
        </div>
        {renderResultCards()}
      </div>}
      </div>
    </div>

    {toast && <div style={{position:"fixed",left:"50%",bottom:78,transform:"translateX(-50%)",background:"#0f172a",color:"#fff",padding:"10px 14px",borderRadius:999,fontSize:"0.78rem",fontWeight:900,boxShadow:"0 8px 24px rgba(15,23,42,0.26)",zIndex:60}}>{toast}</div>}
    <AdBannerPlaceholder />
  </div>;
}

function AdBannerPlaceholder() {
  return <div style={{flexShrink:0,background:"#0f172a",borderTop:"1px solid #334155",padding:"6px 10px 8px"}}>
    <div style={{height:52,maxWidth:728,margin:"0 auto",border:"1.5px dashed #64748b",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",background:"#111827",color:"#94a3b8",fontSize:"0.72rem",fontWeight:900,letterSpacing:"0.06em"}}>
      ADMOB BANNER AREA
    </div>
  </div>;
}

function kindLabel(kind) {
  if (kind === "xor") return "XOR";
  if (kind === "xnor") return "XNOR";
  if (kind === "majority") return "Majority";
  if (kind === "half_sum") return "Half Adder Sum";
  if (kind === "half_carry") return "Half Adder Carry";
  if (kind === "full_sum") return "Full Adder Sum";
  if (kind === "full_carry") return "Full Adder Carry";
  if (kind === "mux") return "2:1 MUX";
  return kind;
}

function CompactLine({ label, children }) {
  return <div style={{display:"inline-flex",alignItems:"center",gap:4,minWidth:0,width:"fit-content",maxWidth:"100%"}}><span style={{fontSize:"0.6rem",fontWeight:950,color:"#475569",width:32,textTransform:"uppercase",letterSpacing:"0.03em",flex:"0 0 32px"}}>{label}</span><div style={{minWidth:0,flex:"0 0 auto"}}>{children}</div></div>;
}

function PillGroup({ value, setValue, items, disabled=false, fixed=false, size="sm" }) {
  const buttonWidth = (lbl) => {
    if (size === "xs") return 31;
    if (size === "impl") return lbl === "NAND" ? 45 : 40;
    if (size === "md") return 50;
    return lbl.length <= 3 ? 48 : 52;
  };
  return <div style={{display:"flex",gap:3,background:disabled?"#e2e8f0":"#0f172a",borderRadius:9,padding:3,opacity:disabled?0.58:1,maxWidth:"100%",overflow:"hidden"}}>{items.map(([id,lbl])=>{
    const active = value===id;
    const w = buttonWidth(lbl);
    return <button key={id} disabled={disabled} onClick={()=>!disabled && setValue(id)} style={{width:fixed?w:undefined,minWidth:fixed?w:undefined,minHeight:29,padding:fixed?"5px 0":"5px 9px",borderRadius:7,border:"none",background:active?"#3b82f6":"transparent",color:active?"#fff":disabled?"#64748b":"#94a3b8",fontFamily:"inherit",fontSize:"0.66rem",fontWeight:900,cursor:disabled?"not-allowed":"pointer",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{lbl}</button>;
  })}</div>;
}

function controlPanel() {
  return {
    background:"#e2e8f0",
    padding:"6px 9px",
    display:"block",
    flexShrink:0,
    borderBottom:"1px solid #cbd5e1",
    boxShadow:"0 1px 4px rgba(15,23,42,0.06)"
  };
}


function appHeader() {
  return {
    background:"#1e293b",
    padding:"7px 10px",
    display:"flex",
    alignItems:"center",
    gap:8,
    flexShrink:0,
    borderBottom:"1px solid #0f172a"
  };
}

function mainTab(active) { return {minHeight:38,border:"none",borderRadius:9,background:active?"#3b82f6":"#0f172a",color:active?"#fff":"#94a3b8",fontSize:"0.84rem",fontWeight:950,cursor:"pointer",boxShadow:active?"0 1px 8px rgba(59,130,246,0.28)":"none"}; }
function exprLine(active=false) {
  return {
    border:active ? "1.5px solid #334155" : "1px solid #e2e8f0",
    background:active ? "#f8fafc" : "#fff",
    borderRadius:8,
    padding:"6px 7px",
    marginTop:5,
    minWidth:0
  };
}
function exprLineTitle(active=false) {
  return {
    display:"inline-block",
    minWidth:34,
    padding:"2px 6px",
    borderRadius:999,
    background:active ? "#334155" : "#e2e8f0",
    color:active ? "#fff" : "#475569",
    fontSize:"0.58rem",
    fontWeight:950,
    letterSpacing:"0.06em",
    marginBottom:4
  };
}
function exprLineHeader() {
  return {display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:5};
}
function exprLineHint() {
  return {fontSize:"0.54rem",fontWeight:950,color:"#94a3b8",letterSpacing:"0.04em",textTransform:"uppercase"};
}
function exprGroupList() {
  return {display:"flex",flexDirection:"column",gap:4,minWidth:0};
}
function exprGroupTermRow(color, selected=false) {
  return {
    width:"100%",
    display:"flex",
    alignItems:"center",
    gap:6,
    border:selected ? `1.5px solid ${color}` : "1px solid #e2e8f0",
    background:selected ? `${color}12` : "#fff",
    borderRadius:7,
    padding:"5px 6px",
    cursor:"pointer",
    fontFamily:"inherit",
    overflow:"visible",
    minWidth:0
  };
}
function exprGroupBadge(color) {
  return {
    minWidth:26,
    height:18,
    borderRadius:999,
    display:"inline-flex",
    alignItems:"center",
    justifyContent:"center",
    background:`${color}18`,
    color,
    fontSize:"0.58rem",
    fontWeight:950,
    flex:"0 0 auto"
  };
}
function exprResultLine() {
  return {marginTop:6,paddingTop:6,borderTop:"1px dashed #cbd5e1",display:"grid",gridTemplateColumns:"46px minmax(0,1fr)",gap:6,alignItems:"baseline"};
}
function exprResultLabel() {
  return {fontSize:"0.58rem",fontWeight:950,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.04em"};
}
function exprResultText() {
  return {
    fontFamily:"'Courier New',monospace",
    fontWeight:900,
    color:"#0f172a",
    whiteSpace:"normal",
    overflow:"visible",
    overflowWrap:"anywhere",
    wordBreak:"break-word",
    lineHeight:1.35,
    minWidth:0
  };
}
function groupChip(color, selected=false) {
  return {
    display:"inline-flex",
    alignItems:"center",
    gap:5,
    background:selected ? `${color}14` : "#fff",
    border:`1.5px solid ${selected ? color : "#e2e8f0"}`,
    borderRadius:6,
    padding:"4px 10px",
    fontSize:"0.7rem",
    cursor:"pointer",
    fontFamily:"inherit",
    boxShadow:selected ? `0 0 0 2px ${color}22` : "none"
  };
}
function resultWrap() {
  return {
    width:"100%",
    maxWidth:760,
    display:"grid",
    gridTemplateColumns:"1fr",
    gap:8
  };
}
function exprCard() { return {background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,padding:"9px 11px",boxShadow:"0 1px 6px rgba(15,23,42,0.06)",minWidth:0}; }
function recoCard() { return {background:"#ecfdf5",border:"1px solid #99f6e4",borderRadius:10,padding:"9px 11px",boxShadow:"0 1px 6px rgba(15,23,42,0.04)",minWidth:0,minHeight:132,boxSizing:"border-box"}; }
function resultSection() { return {display:"grid",gridTemplateColumns:"78px minmax(0,1fr)",gap:6,alignItems:"baseline",minHeight:18,marginTop:2}; }
function resultKey() { return {fontSize:"0.62rem",fontWeight:950,color:"#64748b",whiteSpace:"nowrap"}; }
function resultVal() { return {fontSize:"0.72rem",fontWeight:950,color:"#334155",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",minWidth:0}; }
function cardLabel() { return {fontSize:"0.58rem",fontWeight:950,color:"#64748b",letterSpacing:"0.08em",marginBottom:4}; }

function optionRows() {
  return {
    display:"grid",
    gridTemplateColumns:"1fr",
    gap:4,
    width:"100%",
    maxWidth:430,
    margin:"0 auto"
  };
}
function optionRow() {
  return {
    display:"flex",
    alignItems:"center",
    justifyContent:"space-between",
    gap:5,
    flexWrap:"wrap",
    minWidth:0,
    width:"100%"
  };
}

function clearBtn() {
  return {
    width:60,
    minWidth:60,
    minHeight:29,
    padding:"5px 0",
    border:"1.5px solid #cbd5e1",
    borderRadius:9,
    background:"#fff",
    color:"#334155",
    fontSize:"0.66rem",
    fontWeight:950,
    cursor:"pointer",
    whiteSpace:"nowrap"
  };
}
function exampleBtn(active=false) {
  return {
    width:72,
    minWidth:72,
    minHeight:29,
    padding:"5px 0",
    border:active ? "1.5px solid #1d4ed8" : "1.5px solid #cbd5e1",
    borderRadius:9,
    background:active ? "#2563eb" : "#fff",
    color:active ? "#fff" : "#1e293b",
    fontSize:"0.66rem",
    fontWeight:950,
    cursor:"pointer",
    whiteSpace:"nowrap",
    overflow:"hidden",
    textOverflow:"ellipsis"
  };
}
function exampleMenu() {
  return {
    position:"absolute",
    top:"calc(100% + 6px)",
    right:0,
    width:220,
    background:"#fff",
    border:"1.5px solid #cbd5e1",
    borderRadius:12,
    boxShadow:"0 12px 28px rgba(15,23,42,0.18)",
    padding:6,
    zIndex:200
  };
}
function exampleItem(active=false) {
  return {
    width:"100%",
    minHeight:32,
    display:"flex",
    alignItems:"center",
    justifyContent:"space-between",
    gap:8,
    padding:"7px 9px",
    border:"none",
    borderRadius:8,
    background:active ? "#dbeafe" : "transparent",
    color:active ? "#1d4ed8" : "#334155",
    fontFamily:"inherit",
    fontSize:"0.73rem",
    fontWeight:active ? 950 : 850,
    cursor:"pointer",
    textAlign:"left"
  };
}
function xorBtn(active) {
  return {
    width:38,
    minWidth:38,
    minHeight:29,
    padding:"5px 0",
    borderRadius:9,
    border:"none",
    background:active?"#7c3aed":"#0f172a",
    color:active?"#fff":"#94a3b8",
    fontFamily:"inherit",
    fontSize:"0.66rem",
    fontWeight:900,
    cursor:"pointer"
  };
}

