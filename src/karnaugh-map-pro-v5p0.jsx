
/*
v4p12 router-clean
- NetGraph floating-net pruning
- Explicit junction dots by graph degree
- Symbol/wire clearance boxes
- Compact uniform gate geometry
- Dynamic lane and term spacing
*/

import { useState, useCallback, useMemo, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════════
//  K-MAP CORE - dynamic 2/3/4 variable support
// ═══════════════════════════════════════════════════════════
const GROUP_COLORS = ["#e53935","#1e88e5","#43a047","#fb8c00","#8e24aa","#00897b"];
const ALL_VARS = ["A","B","C","D"];

function grayCodes(bits) {
  if (bits <= 0) return [""];
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

function cellToMinterm(row, col, cfg) { return parseInt(cfg.rowGray[row] + cfg.colGray[col], 2); }
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
    .filter(g => g.every(m => allowed.has(m)) && g.some(m => targetSet.has(m)))
    .sort((a,b) => b.length - a.length || a[0] - b[0]);

  const groups = [], covered = new Set(), used = new Set();
  for (const g of cands) {
    const key = uniqGroupKey(g);
    const coversNew = g.some(m => targetSet.has(m) && !covered.has(m));
    if (!used.has(key) && coversNew) {
      used.add(key);
      groups.push(g);
      g.forEach(m => { if (targetSet.has(m)) covered.add(m); });
    }
    if (covered.size === targets.length) break;
  }
  for (const m of targets) if (!covered.has(m)) groups.push([m]);
  return groups;
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

function posGroupProductText(terms) {
  // Product-form helper retained for internal experiments only.
  // UI POS group rows intentionally show the maxterm itself, so the
  // group color maps directly to the POS term shown in Result.
  if (!terms.length) return "0";
  return terms.map(literalText).join("·");
}
function posDisplayTermExpr(terms) { return posTermExpr(terms); }


function coloredTermList(termsList, form="SOP") {
  return termsList.map((terms, i) => ({
    key: `${form}_${i}`,
    color: GROUP_COLORS[i % GROUP_COLORS.length],
    text: form === "SOP" ? sopTermExpr(terms) : posDisplayTermExpr(terms),
  }));
}
function joinExprTerms(items, joiner) {
  return items.length ? items.map(x => x.text).join(joiner) : "";
}

function groupContains(group, m) {
  return group.includes(m);
}
function cellNeighborM(row, col, dir, cfg) {
  const r = dir === "up" ? (row - 1 + cfg.rows) % cfg.rows : dir === "down" ? (row + 1) % cfg.rows : row;
  const c = dir === "left" ? (col - 1 + cfg.cols) % cfg.cols : dir === "right" ? (col + 1) % cfg.cols : col;
  return cellToMinterm(r, c, cfg);
}
function groupCellEdges(group, row, col, cfg) {
  const edges = {};
  const dirs = [["top","up"],["bottom","down"],["left","left"],["right","right"]];
  dirs.forEach(([edge, dir]) => {
    edges[edge] = !groupContains(group, cellNeighborM(row, col, dir, cfg));
  });
  return edges;
}
function groupOverlayStyle(color, groupIndex, edge, active=false, dim=false) {
  const inset = 3 + (groupIndex % 4) * 4;
  const base = {
    position:"absolute",
    pointerEvents:"none",
    zIndex:4 + groupIndex,
    background:color,
    opacity:dim ? 0.22 : active ? 1 : 0.72,
    borderRadius:3
  };
  const thickness = active ? 4 : 3;
  if (edge === "top") return {...base, left:inset, right:inset, top:inset, height:thickness};
  if (edge === "bottom") return {...base, left:inset, right:inset, bottom:inset, height:thickness};
  if (edge === "left") return {...base, top:inset, bottom:inset, left:inset, width:thickness};
  return {...base, top:inset, bottom:inset, right:inset, width:thickness};
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



function kmapGroupLoopStyle(color, active=false, dim=false) {
  return {
    position:"absolute",
    border:`${active ? 4 : 3}px solid ${color}`,
    borderRadius:14,
    pointerEvents:"none",
    opacity:dim ? 0.16 : active ? 1 : 0.82,
    boxShadow:active ? `0 0 0 3px ${color}22` : "none",
    zIndex:30
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
  for (let mask=1; mask<(1<<varCount); mask++) if (bitCount(mask) === 2) masks.push(mask);
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

  const sopGroups = findGroups(ones, xs, cfg);
  const posGroups = findGroups(zeros, xs, cfg);
  const sopTerms = sopGroups.map(g => groupToSopTerms(g, vars, vars.length));
  const posTerms = posGroups.map(g => groupToPosTerms(g, vars, vars.length));

  const sop = {
    form:"SOP", vars, cfg,
    target: ones,
    groups: sopGroups,
    termsList: sopTerms,
    expr: ones.length === 0 ? "F = 0" : ones.length + xs.length === total ? "F = 1" : "F = " + sopTerms.map(sopTermExpr).join(" + "),
  };
  const pos = {
    form:"POS", vars, cfg,
    target: zeros,
    groups: posGroups,
    termsList: posTerms,
    expr: zeros.length === 0 ? "F = 1" : zeros.length + xs.length === total ? "F = 0" : "F = " + posTerms.map(posTermExpr).join(" · "),
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

function AndGate({ x, y, label="AND", bubble=false, w=AND_W, h=AND_H }) {
  const bodyW = w * 0.54;
  const gateH = h;
  const out = x + bodyW + gateH;
  const bubbleR = 4.2;
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
  const r = 4.8;

  const left = x;
  const right = x + w;
  const top = y - h;
  const bottom = y + h;

  const shoulder = w * 0.26;     // short top/bottom straight segment
  const back = w * 0.10;         // left start of the curved input side

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
    {bubble && <circle cx={right+r+1} cy={y} r={r} fill="#fff" stroke="#111" strokeWidth="1.9" />}
    <text x={x+w*0.52} y={y+4} textAnchor="middle" fontSize="8.2" fontFamily="Arial,sans-serif" fontWeight="800">{label}</text>
  </g>;
}

function NotGate({ x, y, label="INV" }) {
  const bubbleR = 3.6;
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
  const r = 4.8;

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
    {bubble && <circle cx={right+r+1} cy={y} r={r} fill="#fff" stroke="#111" strokeWidth="1.9" />}
  </g>;
}

function outX(kind, x, impl="standard") {
  if (kind === "or") return x + OR_W + (impl === "nor" ? 8.5 : 0);
  if (kind === "and") return x + AND_W*0.54 + AND_H + (impl === "nand" ? 8.5 : 0);
  if (kind === "xor") return x + OR_W;
  return x;
}
function fitViewBox(baseW, baseH, points, pad=44) {
  const xs = points.map(p => p[0]).filter(Number.isFinite);
  const ys = points.map(p => p[1]).filter(Number.isFinite);
  if (!xs.length || !ys.length) return { minX:0, minY:0, width:baseW, height:baseH };
  const minX = Math.max(0, Math.min(...xs) - pad);
  const minY = Math.max(0, Math.min(...ys) - pad);
  const maxX = Math.min(baseW, Math.max(...xs) + pad);
  const maxY = Math.min(baseH, Math.max(...ys) + pad);
  return {
    minX,
    minY,
    width: Math.max(360, maxX - minX),
    height: Math.max(220, maxY - minY),
  };
}


function metricLine(plan, impl) {
  const m = estimateMetrics(plan, impl);
  return `Gates ${m.gates} · Literals ${m.literals} · Depth ${m.depth} · Cost ${implementationCost(plan, impl)}`;
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
    candidates.push({ name:"XOR/XNOR Pattern", plan:null, impl:"xor", gates:1, literals:plans.xor.used.length, depth:1, cost:2 });
  }
  candidates.sort((a,b)=> a.cost-b.cost || a.gates-b.gates || a.depth-b.depth || a.literals-b.literals);
  return { best:candidates[0], candidates };
}

// ═══════════════════════════════════════════════════════════
//  CIRCUIT RENDERER - trunked rails with explicit branch dots
// ═══════════════════════════════════════════════════════════
function CircuitDiagram({ plan, implMode, xorInfo, xorEnabled, cells }) {
  const forceXor = implMode === "standard" && xorEnabled && xorInfo;
  if (forceXor) return <XorCircuit xorInfo={xorInfo} />;

  const termsList = plan.termsList;
  const groups = plan.groups;
  const vars = plan.vars || ALL_VARS;
  const form = implMode === "nand" ? "SOP" : implMode === "nor" ? "POS" : plan.form;

  const isZero = plan.expr === "F = 0";
  const isOne = plan.expr === "F = 1";
  if (isZero || isOne) return <ConstCircuit value={isOne ? 1 : 0} />;
  if (implMode === "standard" && termsList.length === 1 && termsList[0]?.length === 1) {
    return <SingleLiteralCircuit term={termsList[0][0]} vars={vars} />;
  }
  return <StableCircuit plan={plan} implMode={implMode} />;

  const SW = 1.7, C = "#111";
  const PAD_L = 58, PAD_T = 28, PAD_R = 88, PAD_B = 36;
  const ROW_GAP = implMode === "standard" ? 48 : 68;
  const INV_OFFSET = implMode === "standard" ? 23 : 32;
  // Columns are deliberately separated so NAND/NOR inverter symbols, signal trunks,
  // product gates, and final gates do not visually collide.
  const NOT_X = implMode === "standard" ? 124 : 230;
  const RAIL_END = implMode === "standard" ? 270 : 500;
  const X_STAGE = implMode === "standard" ? 455 : 840;
  const TERM_GAP = implMode === "standard" ? 64 : 90, TOP_GAP = implMode === "standard" ? 86 : 116;
  // NAND/NOR rows are spaced widely, but each gate input spread stays inside the fixed gate symbol.
  const railY = {}, invY = {};
  vars.forEach((v,i)=>{ railY[v]=PAD_T+24+i*ROW_GAP; invY[v]=railY[v]+INV_OFFSET; });
  const termY = termsList.map((_,i)=> PAD_T + vars.length*ROW_GAP + TOP_GAP + i*TERM_GAP);
  const hasFinal = termsList.length > 1 || implMode === "nand" || implMode === "nor";
  const X_FINAL = X_STAGE + (implMode === "standard" ? 185 : 360);
  const finalY = termY.length ? (termY[0]+termY[termY.length-1])/2 : 250;
  const finalH = Math.max(26, termsList.length * (implMode === "standard" ? 8 : 10) + 14);
  const X_OUT = X_FINAL + 118;
  const W = X_OUT + PAD_R;
  const H = Math.max(finalY + finalH + 80, termY[termY.length-1] + (implMode === "standard" ? 70 : 96)) + PAD_B;

  const usedVarSet = new Set();
  const needsInv = new Set();
  termsList.forEach(ts => ts.forEach(t=>{ usedVarSet.add(t.var); if (t.inv) needsInv.add(t.var); }));

  const layers = { grid:[], bus:[], wires:[], gates:[], dots:[], labels:[] };
  const contentPoints = [];
  const mark = (...pts) => pts.forEach(p => contentPoints.push(p));
  const dots = new Set();
  const addDot = (x,y)=>dots.add(`${Math.round(x)},${Math.round(y)}`);
  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) layers.grid.push(<circle key={`g${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc" />);

  vars.forEach(v => {
    const y = railY[v], active = usedVarSet.has(v);
    mark([PAD_L,y],[RAIL_END,y]);
    layers.bus.push(<line key={`rail_${v}`} x1={PAD_L} y1={y} x2={RAIL_END} y2={y} stroke={active?C:"#cbd5e1"} strokeWidth={active?SW:1.15} strokeLinecap="square" />);
    layers.labels.push(<text key={`lbl_${v}`} x={PAD_L-10} y={y+4.5} textAnchor="end" fontSize="13.5" fontFamily="'Courier New',monospace" fontWeight="800" fill={active?"#1e293b":"#94a3b8"}>{v}</text>);
    if (needsInv.has(v)) {
      const by = invY[v], branchX = NOT_X - (implMode === "standard" ? 20 : 55);
      const invOut = implMode === "nand" ? outX("and", NOT_X, "nand") : implMode === "nor" ? outX("or", NOT_X, "nor") : NOT_X + NOT_W;

      if (implMode === "nand" || implMode === "nor") {
        // Gate-pin routing: a NAND/NOR-as-inverter has two tied inputs.
        // Do not draw a single center wire through the gate body.
        const pinA = by;
        const pinB = by;
        mark([branchX-13,y],[branchX,pinB],[NOT_X,pinA],[NOT_X,pinB],[RAIL_END,by]);
        layers.bus.push(<line key={`ibh_${v}`} x1={branchX-13} y1={y} x2={branchX} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
        layers.bus.push(<line key={`ibv_${v}`} x1={branchX} y1={y} x2={branchX} y2={pinB} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
        layers.bus.push(<line key={`iin_${v}`} x1={branchX} y1={by} x2={NOT_X+1} y2={by} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
        layers.gates.push(implMode === "nand"
          ? <AndGate key={`not_${v}`} x={NOT_X} y={by} w={44} h={18} label="" bubble />
          : <OrGate key={`not_${v}`} x={NOT_X} y={by} h={14} label="" bubble />
        );
      } else {
        mark([branchX-13,y],[branchX,by],[NOT_X,by],[RAIL_END,by]);
        layers.bus.push(<line key={`ibh_${v}`} x1={branchX-13} y1={y} x2={branchX} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
        layers.bus.push(<line key={`ibv_${v}`} x1={branchX} y1={y} x2={branchX} y2={by} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
        layers.bus.push(<line key={`iin_${v}`} x1={branchX} y1={by} x2={NOT_X} y2={by} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
        layers.gates.push(<NotGate key={`not_${v}`} x={NOT_X} y={by} />);
      }

      layers.bus.push(<line key={`iout_${v}`} x1={invOut + 6} y1={by} x2={RAIL_END} y2={by} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      layers.labels.push(<text key={`ilbl_${v}`} x={invOut+7} y={by-7} fontSize="9.5" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{v+"'"}</text>);
      addDot(branchX, y);
    }
  });

  const signalUses = new Map();
  const signalKey = t => `${t.var}_${t.inv?"INV":"RAW"}`;
  const keyVar = key => key.split("_")[0];
  const srcY = key => key.endsWith("INV") ? invY[keyVar(key)] : railY[keyVar(key)];

  termsList.forEach((terms, gi) => {
    const gy = termY[gi], n = terms.length;
    const spread = n <= 1 ? 0 : Math.min((n-1)*(implMode === "standard" ? 10 : 9), implMode === "standard" ? 32 : 28);
    const offs = terms.map((_,ti)=> n<=1 ? 0 : -spread/2 + ti*spread/(n-1));
    terms.forEach((t,ti)=>{
      const key=signalKey(t), pinY=gy+offs[ti];
      if (!signalUses.has(key)) signalUses.set(key, []);
      signalUses.get(key).push({ gi, ti, pinY });
    });

    const firstKind = implMode === "nand" ? "nand" : implMode === "nor" ? "nor" : form === "SOP" ? "and" : "or";
    const gateLabel = implMode === "nand" ? "NAND" : implMode === "nor" ? "NOR" : form === "SOP" ? "AND" : "OR";
    mark([X_STAGE-4, gy-34], [outX(firstKind === "or" || firstKind === "nor" ? "or" : "and", X_STAGE, implMode), gy+34]);
    if (n === 1 && implMode === "standard") {
      // Direct single-literal connection: no BUF gate, wire only.
    }
    else if (firstKind === "nand") layers.gates.push(<AndGate key={`nand_${gi}`} x={X_STAGE} y={gy} label="" bubble />);
    else if (firstKind === "nor") layers.gates.push(<OrGate key={`nor_${gi}`} x={X_STAGE} y={gy} h={22} label="" bubble />);
    else if (firstKind === "and") layers.gates.push(<AndGate key={`and_${gi}`} x={X_STAGE} y={gy} label={gateLabel} />);
    else layers.gates.push(<OrGate key={`or_${gi}`} x={X_STAGE} y={gy} h={22} label={gateLabel} />);

    const termText = form === "SOP" ? sopTermExpr(terms) : posTermExpr(terms);
    layers.labels.push(<text key={`tl_${gi}`} x={X_STAGE} y={gy-(implMode === "standard" ? 28 : 30)} fontSize={implMode === "standard" ? "10.5" : "9.2"} fontFamily="'Courier New',monospace" fontWeight="800" fill={GROUP_COLORS[gi%GROUP_COLORS.length]}>{termText}</text>);
  });

  const orderedKeys = vars.flatMap(v=>[`${v}_RAW`,`${v}_INV`]).filter(k=>signalUses.has(k));
  const trunkX = {};
  orderedKeys.forEach((k,i)=>{ trunkX[k] = RAIL_END + 26 + i*(implMode === "standard" ? 34 : 42); });
  orderedKeys.forEach(key => {
    const uses = signalUses.get(key), x = trunkX[key], sy = srcY(key);
    const minY = Math.min(sy, ...uses.map(u=>u.pinY)), maxY = Math.max(sy, ...uses.map(u=>u.pinY));
    mark([RAIL_END,sy],[x,minY],[x,maxY],[X_STAGE, maxY]);
    if (x > RAIL_END) layers.wires.push(<line key={`re_${key}`} x1={RAIL_END} y1={sy} x2={x} y2={sy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    layers.wires.push(<line key={`tr_${key}`} x1={x} y1={minY} x2={x} y2={maxY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    addDot(x, sy);
    uses.forEach(u => {
      layers.wires.push(<line key={`br_${key}_${u.gi}_${u.ti}`} x1={x} y1={u.pinY} x2={X_STAGE + 1} y2={u.pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      addDot(x, u.pinY);
    });
  });

  const firstOut = (terms, gy) => {
    if (implMode === "nand") return outX("and", X_STAGE, "nand");
    if (implMode === "nor") return outX("or", X_STAGE, "nor");
    if (terms.length === 1) return X_STAGE;
    return form === "SOP" ? outX("and", X_STAGE) : outX("or", X_STAGE);
  };

  mark([X_FINAL-55, finalY-finalH-12], [X_OUT+24, finalY+finalH+12]);
  if (hasFinal) {
    termsList.forEach((terms,gi)=>{
      const gy = termY[gi];
      const pinSpread = Math.min((termsList.length-1)*(implMode === "standard" ? 12 : 15), (finalH-5)*2);
      const pinY = finalY + (termsList.length===1 ? 0 : -pinSpread/2 + gi*pinSpread/(termsList.length-1));
      const collectX = X_FINAL - 58 - (termsList.length-1-gi)*13;
      layers.wires.push(<line key={`fh_${gi}`} x1={firstOut(terms, gy)} y1={gy} x2={collectX} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      if (Math.abs(gy-pinY)>0.5) layers.wires.push(<line key={`fv_${gi}`} x1={collectX} y1={gy} x2={collectX} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      layers.wires.push(<line key={`fp_${gi}`} x1={collectX} y1={pinY} x2={X_FINAL + 1} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    });
    if (implMode === "nand") layers.gates.push(<AndGate key="final" x={X_FINAL} y={finalY} label="" bubble />);
    else if (implMode === "nor") layers.gates.push(<OrGate key="final" x={X_FINAL} y={finalY} h={finalH} label="" bubble />);
    else if (form === "SOP") layers.gates.push(<OrGate key="final" x={X_FINAL} y={finalY} h={finalH} label="OR" />);
    else layers.gates.push(<AndGate key="final" x={X_FINAL} y={finalY} label="AND" />);
    const fx = implMode === "nand" ? outX("and", X_FINAL, "nand") : implMode === "nor" ? outX("or", X_FINAL, "nor") : form === "SOP" ? outX("or", X_FINAL) : outX("and", X_FINAL);
    layers.wires.push(<line key="out" x1={fx} y1={finalY} x2={X_OUT} y2={finalY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    layers.gates.push(<g key="f"><circle cx={X_OUT} cy={finalY} r="4.8" fill={C}/><text x={X_OUT+20} y={finalY+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F</text></g>);
  } else {
    const gy = termY[0], fx = firstOut(termsList[0], gy);
    layers.wires.push(<line key="single" x1={fx} y1={gy} x2={X_OUT} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    layers.gates.push(<g key="f"><circle cx={X_OUT} cy={gy} r="4.8" fill={C}/><text x={X_OUT+20} y={gy+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F</text></g>);
  }

  dots.forEach(k=>{ const [x,y]=k.split(",").map(Number); layers.dots.push(<circle key={`d_${k}`} cx={x} cy={y} r="3.6" fill={C}/>); });

  const vb = fitViewBox(W + 120, H + 90, contentPoints.concat([[PAD_L-40, PAD_T-20], [X_OUT+160, finalY+finalH+48]]), 44);
  return <svg viewBox={`${vb.minX} ${vb.minY} ${vb.width} ${vb.height}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W + 120} height={H + 90} fill="#f8f9ff" />
    {layers.grid}{layers.bus}{layers.wires}{layers.gates}{layers.dots}{layers.labels}
    <text x={vb.minX+vb.width-18} y={vb.minY+vb.height-16} textAnchor="end" fontSize="10" fontFamily="Arial,sans-serif" fill="#64748b">{form} · {implMode.toUpperCase()} · compact</text>
  </svg>;
}




function StableCircuit({ plan, implMode="standard" }) {
  const C = "#111", SW = 1.65;
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
  const railX1 = 190;
  const invX = 250;
  const laneX0 = 420;
  const laneGap = 38;
  const gateX = 720;
  const finalX = 1058;
  const yTop = 64;
  const railGap = implMode === "standard" ? 42 : 50;

  const gateHeightForFanIn = (n) => Math.max(24, Math.min(46, n * 9 + 12));
  const finalHeightForFanIn = (n) => Math.max(32, Math.min(62, n * 8 + 20));
  const gateInputX = (kind, x) => (kind === "or" || kind === "nor") ? x + 10 : x;
  const andOutCustom = (x, h, bubble=false, w=56) => x + w * 0.54 + h + (bubble ? 8.5 : 0);
  const orOutCustom = (x, bubble=false) => x + OR_W + (bubble ? 8.5 : 0);
  const gateOutX = (kind, x, h) => {
    if (kind === "or") return orOutCustom(x, false);
    if (kind === "nor") return orOutCustom(x, true);
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
  const termGap = Math.max(76, maxTermH * 2 + 28);
  const termY0 = yTop + vars.length * railGap + 96;
  const termYs = termsList.map((_, i) => termY0 + i * termGap);
  const finalY = (termYs[0] + termYs[termYs.length - 1]) / 2;
  const finalGateH = finalHeightForFanIn(Math.max(termCount, 1));
  const finalOut = gateOutX(finalKind, finalX, finalGateH);
  const outXpos = finalOut + 94;
  const H = Math.max(410, Math.max(...termYs) + maxTermH + 120, finalY + finalGateH + 120);
  const W = outXpos + 150;

  const norm = n => Math.round(n * 10) / 10;
  const pKey = (x,y) => `${norm(x)},${norm(y)}`;

  const pins = new Map();
  const routes = [];
  const decorativeSegs = [];
  const gates = [];
  const labels = [];
  const dotCandidates = [];
  const forbiddenDots = new Set();

  const addPin = (id, x, y, net, kind="junction") => {
    if (![x,y].every(Number.isFinite)) return null;
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
    const pitch = terms.length <= 1 ? 0 : Math.min(15, (h * 1.55) / (terms.length - 1));
    const spread = terms.length <= 1 ? 0 : pitch * (terms.length - 1);
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
      labels.push(<text key={`lane_lbl_${lit}`} x={lx} y={termY0-52} textAnchor="middle" fontSize="10" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">{lit}</text>);
    }

    if (usedInv.has(v)) {
      const iy = y + (implMode === "standard" ? 22 : 26);
      addPin(`inv_in_${v}`, invX, iy, v, "gateIn");
      connect(`inv_feed_${v}`, `branch_${v}`, `inv_in_${v}`, [[railX1, iy]], "feed");
      const invH = gateHeightForFanIn(1);
      if (isNand) gates.push(<AndGate key={`inv_${v}`} x={invX} y={iy} w={48} h={18} label="" bubble />);
      else if (isNor) gates.push(<OrGate key={`inv_${v}`} x={invX} y={iy} h={15} label="" bubble />);
      else gates.push(<NotGate key={`inv_${v}`} x={invX} y={iy} label="" />);

      const lit = `${v}'`;
      const invOut = isNand ? andOutCustom(invX, 18, true, 48) : isNor ? orOutCustom(invX, true) : invX + NOT_W;
      addPin(`inv_out_${v}`, invOut + 8, iy, lit, "source");
      addPin(`lane_src_${lit}`, laneX[lit], iy, lit, "junction");
      connect(`inv_out_wire_${v}`, `inv_out_${v}`, `lane_src_${lit}`, [], "entry");
      labels.push(<text key={`lane_lbl_${lit}`} x={laneX[lit]} y={termY0-52} textAnchor="middle" fontSize="10" fontWeight="800" fontFamily="'Courier New',monospace" fill="#92400e">{lit}</text>);
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

    const termText = form === "SOP" ? sopTermExpr(terms) : posTermExpr(terms);
    labels.push(<text key={`term_lbl_${gi}`} x={gateX} y={gy-h-8} fontSize="9.3" fontFamily="'Courier New',monospace" fontWeight="800" fill={GROUP_COLORS[gi%GROUP_COLORS.length]}>{termText}</text>);

    const termOut = gateOutX(termKind, gateX, h) + 8;
    addPin(`term_out_${gi}`, termOut, gy, `T${gi}`, "source");

    const finalInputX = gateInputX(finalKind, finalX);
    const fPitch = termCount <= 1 ? 0 : Math.min(13, (finalGateH * 1.55) / (termCount - 1));
    const fSpread = termCount <= 1 ? 0 : fPitch * (termCount - 1);
    const fPinY = termCount === 1 ? finalY : finalY - fSpread/2 + gi * fPitch;
    const finalPinId = `final_in_${gi}`;
    addPin(finalPinId, finalInputX, fPinY, `T${gi}`, "gateIn");
    const midX = finalX - 112 - Math.min(gi, termCount-1-gi) * 22;
    connect(`term_to_final_${gi}`, `term_out_${gi}`, finalPinId, [[midX, gy], [midX, fPinY]], "route");
  });

  const finalYForOutput = termCount > 1 || implMode !== "standard" ? finalY : termYs[0];
  if (termCount > 1 || implMode !== "standard") {
    if (finalKind === "nand") gates.push(<AndGate key="final" x={finalX} y={finalY} w={58} h={finalGateH} label="" bubble />);
    else if (finalKind === "nor") gates.push(<OrGate key="final" x={finalX} y={finalY} h={finalGateH} label="" bubble />);
    else if (finalKind === "or") gates.push(<OrGate key="final" x={finalX} y={finalY} h={finalGateH} label="OR" />);
    else gates.push(<AndGate key="final" x={finalX} y={finalY} w={58} h={finalGateH} label="AND" />);
    addPin("final_out", finalOut + 8, finalY, "F", "source");
    addPin("F_out", outXpos, finalY, "F", "out");
    connect("final_to_F", "final_out", "F_out", [], "output");
  } else {
    addPin("F_out", outXpos, finalYForOutput, "F", "out");
    // Single standard term: connect the term output directly to F.
    pins.get("term_out_0").net = "F";
    connect("single_to_F", "term_out_0", "F_out", [], "output");
  }
  labels.push(<circle key="out_dot" cx={outXpos} cy={finalYForOutput} r="4.6" fill={C}/>);
  labels.push(<text key="out_lbl" x={outXpos+18} y={finalYForOutput+5} fontSize="16" fontWeight="900" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>);

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
    const a = pKey(s.x1,s.y1), b = pKey(s.x2,s.y2);
    return s.net + "|" + (a < b ? `${a}|${b}` : `${b}|${a}`);
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
  byNet.clear();
  splitSegments.forEach(s => { if (!byNet.has(s.net)) byNet.set(s.net, []); byNet.get(s.net).push(s); });
  byNet.forEach((list, net) => {
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

  const grid=[];
  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) grid.push(<circle key={`g_${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);

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
  const railFanoutUsed = new Set();
  dotCandidates.forEach(d => {
    const point = pKey(d.x,d.y);
    if (forbiddenDots.has(point)) return;
    if (d.role !== "fanout" && d.role !== "tap") return;
    const deg = degreeByNetPoint.get(`${d.net}|${point}`) || 0;
    if (deg < 3) return;
    if (vars.includes(d.net) && Math.abs(d.y - railY[d.net]) < 0.5) {
      if (railFanoutUsed.has(d.net)) return;
      railFanoutUsed.add(d.net);
    }
    dotMap.set(`${d.net}|${point}`, d);
  });
  const dots = [...dotMap.values()].map((d,i)=><circle key={`dot_${i}_${d.net}_${pKey(d.x,d.y)}`} cx={d.x} cy={d.y} r="3.0" fill={C}/>);

  return <svg viewBox={`34 34 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W+80} height={H+80} fill="#f8f9ff" />
    {grid}{wires}{gates}{dots}{labels}
  </svg>;
}


function LogicBlockDiagram({ termsList, form="SOP", vars=ALL_VARS }) {
  const W = 620, H = 250, C = "#111", SW = 1.8;
  const inputX = 86;
  const railStart = 112;
  const railEnd = 210;
  const blockX = 246;
  const blockY = 62;
  const blockW = 170;
  const blockH = 118;
  const gateX = 460;
  const gateY = blockY + blockH/2;
  const outEnd = 570;
  const litCount = termsList.reduce((s,t)=>s+t.length,0);
  const maxFanIn = Math.max(...termsList.map(t=>t.length), 0);
  const dots = [];

  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) {
    dots.push(<circle key={`${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);
  }

  const railYs = vars.map((_, i) => 78 + i*25);
  const outputGateLabel = form === "SOP" ? "OR" : "AND";
  const planeLabel = form === "SOP" ? "Product Terms" : "Sum Terms";
  const termLabel = form === "SOP" ? "AND Plane" : "OR Plane";

  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{dots}

    {vars.map((v,i)=><g key={`in_${v}`}>
      <text x={inputX-14} y={railYs[i]+5} textAnchor="end" fontSize="14" fontWeight="900" fontFamily="'Courier New',monospace" fill="#1e293b">{v}</text>
      <line x1={railStart} y1={railYs[i]} x2={railEnd} y2={railYs[i]} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
    </g>)}

    <line x1={railEnd} y1={railYs[0]} x2={railEnd} y2={railYs[railYs.length-1]} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
    <line x1={railEnd} y1={gateY} x2={blockX} y2={gateY} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
    {railYs.map((y,i)=><circle key={`dot_${i}`} cx={railEnd} cy={y} r="3.5" fill={C}/>)}

    <rect x={blockX} y={blockY} width={blockW} height={blockH} rx="12" fill="#fff" stroke="#111" strokeWidth="1.9"/>
    <text x={blockX+blockW/2} y={blockY+31} textAnchor="middle" fontSize="13" fontWeight="950" fontFamily="Arial,sans-serif" fill="#1e293b">{termLabel}</text>
    <text x={blockX+blockW/2} y={blockY+57} textAnchor="middle" fontSize="20" fontWeight="950" fontFamily="Arial,sans-serif" fill="#2563eb">{termsList.length} Terms</text>
    <text x={blockX+blockW/2} y={blockY+80} textAnchor="middle" fontSize="11.5" fontWeight="850" fontFamily="Arial,sans-serif" fill="#475569">Literals {litCount} · Max fan-in {maxFanIn}</text>
    <text x={blockX+blockW/2} y={blockY+101} textAnchor="middle" fontSize="10.5" fontWeight="850" fontFamily="Arial,sans-serif" fill="#64748b">{planeLabel}</text>

    <line x1={blockX+blockW} y1={gateY} x2={gateX-18} y2={gateY} stroke={C} strokeWidth={SW} strokeLinecap="square"/>

    {form === "SOP"
      ? <OrGate x={gateX} y={gateY} h={32} label={outputGateLabel}/>
      : <AndGate x={gateX} y={gateY} label={outputGateLabel}/>
    }

    <line x1={form === "SOP" ? outX("or", gateX) : outX("and", gateX)} y1={gateY} x2={outEnd} y2={gateY} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
    <circle cx={outEnd} cy={gateY} r="4.8" fill={C}/>
    <text x={outEnd+16} y={gateY+5} fontSize="17" fontWeight="900" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>

    <text x={W-20} y={H-18} textAnchor="end" fontSize="10" fontFamily="Arial,sans-serif" fill="#64748b">{form} · block diagram</text>
  </svg>;
}

function TextbookTwoLevelCircuit({ termsList, form="SOP", vars=ALL_VARS }) {
  // v4p3: connected nets.
  // - Literal rails stop at their last actual tap: no floating-looking vertical nets.
  // - Term input wires connect directly to the left edge of the gate.
  // - Shared inverters remain variable-level, not term-level.
  const C = "#111", SW = 1.75;
  const termCount = termsList.length;
  const maxLits = Math.max(...termsList.map(t => t.length), 1);

  const W = 1040;
  const inputX = 70;
  const inputRailEndX = 190;
  const invX = 220;
  const literalRailStartX = 310;
  const literalLaneGap = 28;
  const gateX = 545;
  const finalX = 800;
  const yTop = 60;
  const inputRailGap = 32;
  const termGap = 68;
  const termStartY = yTop + vars.length * inputRailGap + 74;

  const termYs = termsList.map((_, i) => termStartY + i * termGap);
  const finalY = (termYs[0] + termYs[termYs.length - 1]) / 2;
  const finalH = Math.max(28, termCount * 8 + 18);
  const finalKind = form === "SOP" ? "or" : "and";
  const finalOut = finalKind === "or" ? outX("or", finalX) : outX("and", finalX);
  const outXpos = finalOut + 88;

  const inputRailY = {};
  vars.forEach((v, i) => { inputRailY[v] = yTop + i * inputRailGap; });

  const usedRaw = new Set();
  const usedInv = new Set();
  const usedVarSet = new Set();
  termsList.forEach(ts => ts.forEach(t => {
    usedVarSet.add(t.var);
    if (t.inv) usedInv.add(t.var);
    else usedRaw.add(t.var);
  }));

  const usedLiterals = [];
  vars.forEach(v => {
    if (usedRaw.has(v)) usedLiterals.push(v);
    if (usedInv.has(v)) usedLiterals.push(v + "'");
  });

  const literalX = {};
  usedLiterals.forEach((lit, i) => { literalX[lit] = literalRailStartX + i * literalLaneGap; });

  const minTermY = termYs.length ? Math.min(...termYs) : termStartY;
  const maxTermY = termYs.length ? Math.max(...termYs) : termStartY;
  const laneTop = Math.min(yTop + vars.length * inputRailGap + 22, minTermY - 48);

  const gateInputX = gateX;       // connect wires to actual left edge of gate
  const preGateX = gateX - 34;    // short orthogonal stub before gate
  const finalStepBaseX = finalX - 104;
  const finalStepGap = 12;

  const tapYsByLiteral = {};
  usedLiterals.forEach(lit => { tapYsByLiteral[lit] = []; });

  // Pre-compute every literal tap y so rails stop exactly at the last tap.
  termsList.forEach((terms, gi) => {
    const gy = termYs[gi];
    const spread = terms.length <= 1 ? 0 : Math.min((terms.length-1)*17, 48);
    terms.forEach((t, ti) => {
      const py = terms.length === 1 ? gy : gy - spread/2 + ti * (spread / (terms.length-1));
      const key = t.inv ? t.var + "'" : t.var;
      if (!tapYsByLiteral[key]) tapYsByLiteral[key] = [];
      tapYsByLiteral[key].push(py);
    });
  });

  const railBottomForLiteral = {};
  usedLiterals.forEach(lit => {
    const ys = tapYsByLiteral[lit] || [];
    railBottomForLiteral[lit] = ys.length ? Math.max(...ys) : minTermY;
  });

  const lowestTap = Math.max(maxTermY, ...Object.values(railBottomForLiteral));
  const H = Math.max(330, lowestTap + 120, finalY + finalH + 130);

  const dots = [];
  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) {
    dots.push(<circle key={`${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);
  }

  const wires = [], gates = [], labels = [], branchDots = [];

  vars.forEach(v => {
    const y = inputRailY[v];
    const active = usedVarSet.has(v);
    labels.push(<text key={`lbl_${v}`} x={inputX-14} y={y+5} textAnchor="end" fontSize="13.5" fontWeight="800" fontFamily="'Courier New',monospace" fill={active ? "#1e293b" : "#94a3b8"}>{v}</text>);
    wires.push(<line key={`rail_${v}`} x1={inputX} y1={y} x2={inputRailEndX} y2={y} stroke={active ? C : "#cbd5e1"} strokeWidth={active ? SW : 1.15} strokeLinecap="square" />);

    if (usedRaw.has(v)) {
      const lx = literalX[v];
      const tapX = inputRailEndX - 10;
      const bottom = railBottomForLiteral[v];
      wires.push(<line key={`raw_to_lane_h_${v}`} x1={tapX} y1={y} x2={lx} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      wires.push(<line key={`raw_lane_${v}`} x1={lx} y1={y} x2={lx} y2={bottom} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      labels.push(<text key={`raw_lane_lbl_${v}`} x={lx} y={laneTop-8} textAnchor="middle" fontSize="10.5" fontFamily="'Courier New',monospace" fontWeight="800" fill="#1e293b">{v}</text>);
    }

    if (usedInv.has(v)) {
      const invY = y + 16;
      const tapX = inputRailEndX - 24;
      const lit = v + "'";
      const lx = literalX[lit];
      const bottom = railBottomForLiteral[lit];

      wires.push(<line key={`inv_drop_${v}`} x1={tapX} y1={y} x2={tapX} y2={invY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      wires.push(<line key={`inv_in_${v}`} x1={tapX} y1={invY} x2={invX} y2={invY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      gates.push(<NotGate key={`shared_not_${v}`} x={invX} y={invY} label="" />);
      wires.push(<line key={`inv_out_${v}`} x1={invX+NOT_W+6} y1={invY} x2={lx} y2={invY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      wires.push(<line key={`inv_lane_${v}`} x1={lx} y1={invY} x2={lx} y2={bottom} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      labels.push(<text key={`inv_lane_lbl_${v}`} x={lx} y={laneTop-8} textAnchor="middle" fontSize="10.5" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{lit}</text>);
      labels.push(<text key={`inv_lbl_${v}`} x={invX+NOT_W+12} y={invY-7} fontSize="10.2" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{lit}</text>);
    }
  });

  const litKey = t => t.inv ? t.var + "'" : t.var;
  const sourceXForLiteral = (t, gi, ti, targetY) => {
    const key = litKey(t);
    const lx = literalX[key];
    if (lx == null) return;
    if ((tapYsByLiteral[key] || []).length > 1) {
      branchDots.push(<circle key={`term_tap_dot_${gi}_${ti}`} cx={lx} cy={targetY} r="3.0" fill={C}/>);
    }
    wires.push(<line key={`tap_${gi}_${ti}`} x1={lx} y1={targetY} x2={preGateX} y2={targetY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    wires.push(<line key={`pin_${gi}_${ti}`} x1={preGateX} y1={targetY} x2={gateInputX} y2={targetY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
  };

  termsList.forEach((terms, gi) => {
    const gy = termYs[gi];
    const spread = terms.length <= 1 ? 0 : Math.min((terms.length-1)*17, 48);
    const pinYs = terms.map((_, ti) => terms.length === 1 ? gy : gy - spread/2 + ti * (spread / (terms.length-1)));
    const firstKind = form === "SOP" ? "and" : "or";
    const firstLabel = form === "SOP" ? "AND" : "OR";
    const gateOut = firstKind === "and" ? outX("and", gateX) : outX("or", gateX);

    terms.forEach((t, ti) => sourceXForLiteral(t, gi, ti, pinYs[ti]));

    if (terms.length === 1) {
      wires.push(<line key={`pass_${gi}`} x1={gateInputX} y1={gy} x2={gateOut} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    } else if (firstKind === "and") {
      gates.push(<AndGate key={`term_gate_${gi}`} x={gateX} y={gy} label={firstLabel} />);
    } else {
      gates.push(<OrGate key={`term_gate_${gi}`} x={gateX} y={gy} h={terms.length === 2 ? 23 : 29} label={firstLabel} />);
    }

    const termText = form === "SOP" ? sopTermExpr(terms) : posTermExpr(terms);
    labels.push(<text key={`term_label_${gi}`} x={gateX} y={gy-30} fontSize="10.2" fontFamily="'Courier New',monospace" fontWeight="800" fill={GROUP_COLORS[gi%GROUP_COLORS.length]}>{termText}</text>);

    const pinSpread = Math.min((termCount-1)*13, (finalH-8)*2);
    const pinY = finalY + (termCount === 1 ? 0 : -pinSpread/2 + gi * pinSpread / (termCount-1));

    // v4p5: controlled stair-step routing.
    // Avoids shorting all final inputs onto one vertical comb, while keeping elbows regular.
    const half = (termCount - 1) / 2;
    const stepIndex = gi <= half ? gi : termCount - 1 - gi;
    const collectX = finalStepBaseX - stepIndex * finalStepGap;

    wires.push(<line key={`mid_h_${gi}`} x1={terms.length === 1 ? gateX : gateOut} y1={gy} x2={collectX} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    if (Math.abs(gy - pinY) > 0.5) {
      wires.push(<line key={`mid_v_${gi}`} x1={collectX} y1={gy} x2={collectX} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    }
    wires.push(<line key={`mid_p_${gi}`} x1={collectX} y1={pinY} x2={finalX} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
  });

  if (form === "SOP") {
    gates.push(<OrGate key="final_gate" x={finalX} y={finalY} h={finalH} label="OR" />);
  } else {
    gates.push(<AndGate key="final_gate" x={finalX} y={finalY} label="AND" />);
  }

  wires.push(<line key="out" x1={finalOut} y1={finalY} x2={outXpos} y2={finalY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);

  const viewW = Math.max(outXpos + 124, W - 18);
  const viewH = Math.max(H, lowestTap + 130, maxTermY + 140, finalY + finalH + 140);
  return <svg viewBox={`32 34 ${viewW} ${viewH}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={viewW+60} height={viewH+60} fill="#f8f9ff" />{dots}
    {wires}{gates}{labels}{branchDots}
    <circle cx={outXpos} cy={finalY} r="4.8" fill={C}/>
    <text x={outXpos+18} y={finalY+5} fontSize="17" fontWeight="900" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>
  </svg>;
}

function CompactTwoLevelCircuit({ termsList, form="SOP", vars=ALL_VARS }) {
  const C = "#111", SW = 1.8;
  const literalCount = termsList.reduce((s,t)=>s+t.length,0);
  const W = 760;
  const H = Math.max(270, 165 + termsList.length * 66);
  const inputX = 70;
  const railX1 = 195;
  const invX = 126;
  const invRailX1 = 220;
  const laneBaseX = 260;
  const laneGap = 36;
  const gateX = 405;
  const finalX = 600;
  const yTop = 76;
  const railGap = 38;
  const termGap = Math.min(72, Math.max(58, 230 / Math.max(termsList.length, 1)));
  const termYs = termsList.map((_, i) => yTop + vars.length * railGap + 34 + i * termGap);
  const finalY = (termYs[0] + termYs[termYs.length-1]) / 2;
  const finalH = Math.max(28, termsList.length * 11 + 12);
  const finalOut = form === "SOP" ? outX("or", finalX) : outX("and", finalX);
  const outXpos = finalOut + 82;

  const dots=[];
  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) {
    dots.push(<circle key={`${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);
  }

  const wires=[]; const gates=[]; const labels=[]; const branchDots=[];
  const usedRaw = new Set();
  const usedInv = new Set();
  termsList.forEach(ts => ts.forEach(t => {
    if (t.inv) usedInv.add(t.var);
    else usedRaw.add(t.var);
  }));

  const railY = {};
  vars.forEach((v,i) => { railY[v] = yTop + i * railGap; });

  const usedLiterals = [];
  vars.forEach(v => {
    if (usedRaw.has(v)) usedLiterals.push(`${v}`);
    if (usedInv.has(v)) usedLiterals.push(`${v}'`);
  });
  const laneX = {};
  usedLiterals.forEach((lit, i) => { laneX[lit] = laneBaseX + i * laneGap; });

  vars.forEach(v => {
    const y = railY[v];
    const active = usedRaw.has(v) || usedInv.has(v);
    labels.push(<text key={`lbl_${v}`} x={inputX-14} y={y+5} textAnchor="end" fontSize="13.5" fontWeight="800" fontFamily="'Courier New',monospace" fill={active ? "#1e293b" : "#94a3b8"}>{v}</text>);
    wires.push(<line key={`raw_${v}`} x1={inputX} y1={y} x2={railX1} y2={y} stroke={active ? C : "#cbd5e1"} strokeWidth={active ? SW : 1.15} strokeLinecap="square" />);

    if (usedRaw.has(v)) {
      const lx = laneX[v];
      wires.push(<line key={`raw_to_lane_${v}`} x1={railX1} y1={y} x2={lx} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      branchDots.push(<circle key={`dot_raw_${v}`} cx={lx} cy={y} r="3.3" fill={C}/>);
    }

    if (usedInv.has(v)) {
      const iy = y + 18;
      const branchX = invX - 22;
      wires.push(<line key={`inv_bh_${v}`} x1={inputX} y1={y} x2={branchX} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      wires.push(<line key={`inv_bv_${v}`} x1={branchX} y1={y} x2={branchX} y2={iy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      wires.push(<line key={`inv_in_${v}`} x1={branchX} y1={iy} x2={invX} y2={iy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      gates.push(<NotGate key={`not_${v}`} x={invX} y={iy} label="" />);
      const invOut = invX + NOT_W + 6;
      const lit = `${v}'`;
      const lx = laneX[lit];
      wires.push(<line key={`inv_out_${v}`} x1={invOut} y1={iy} x2={lx} y2={iy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      labels.push(<text key={`inv_lbl_${v}`} x={invX+NOT_W+12} y={iy-7} fontSize="10.5" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{lit}</text>);
      branchDots.push(<circle key={`dot_inv_${v}`} cx={branchX} cy={y} r="3.3" fill={C}/>);
      branchDots.push(<circle key={`dot_inv_lane_${v}`} cx={lx} cy={iy} r="3.3" fill={C}/>);
    }
  });

  const litKey = t => t.inv ? `${t.var}'` : t.var;
  const litSourceY = t => t.inv ? railY[t.var] + 18 : railY[t.var];

  termsList.forEach((terms, gi) => {
    const gy = termYs[gi];
    const spread = terms.length <= 1 ? 0 : Math.min((terms.length-1)*18, 42);
    const pinYs = terms.map((_, ti) => terms.length === 1 ? gy : gy - spread/2 + ti*(spread/(terms.length-1)));
    const firstKind = form === "SOP" ? "and" : "or";
    const firstLabel = form === "SOP" ? "AND" : "OR";
    const gateOut = firstKind === "and" ? outX("and", gateX) : outX("or", gateX);

    terms.forEach((t, ti) => {
      const py = pinYs[ti];
      const key = litKey(t);
      const lx = laneX[key];
      const sy = litSourceY(t);
      const elbowX = gateX - 48 - ti * 10;

      // One clean lane per literal, then short tap into this term's gate input.
      if (Math.abs(sy - py) > 0.5) {
        wires.push(<line key={`lane_${gi}_${ti}`} x1={lx} y1={sy} x2={lx} y2={py} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      }
      wires.push(<line key={`tap_${gi}_${ti}`} x1={lx} y1={py} x2={elbowX} y2={py} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      wires.push(<line key={`pin_${gi}_${ti}`} x1={elbowX} y1={py} x2={gateX-24} y2={py} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      branchDots.push(<circle key={`dot_tap_${gi}_${ti}`} cx={lx} cy={py} r="3.2" fill={C}/>);
    });

    if (terms.length === 1) {
      wires.push(<line key={`pass_${gi}`} x1={gateX-24} y1={gy} x2={gateOut} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    } else if (firstKind === "and") {
      gates.push(<AndGate key={`fg_${gi}`} x={gateX} y={gy} label={firstLabel} />);
    } else {
      gates.push(<OrGate key={`fg_${gi}`} x={gateX} y={gy} h={terms.length === 2 ? 23 : 29} label={firstLabel} />);
    }

    const termText = form === "SOP" ? sopTermExpr(terms) : posTermExpr(terms);
    labels.push(<text key={`tl_${gi}`} x={gateX} y={gy-28} fontSize="10.2" fontFamily="'Courier New',monospace" fontWeight="800" fill={GROUP_COLORS[gi%GROUP_COLORS.length]}>{termText}</text>);

    const pinSpread = Math.min((termsList.length-1)*14, (finalH-5)*2);
    const pinY = finalY + (termsList.length===1 ? 0 : -pinSpread/2 + gi*pinSpread/(termsList.length-1));
    const collectX = finalX - 58 - (termsList.length-1-gi)*13;
    wires.push(<line key={`mid1_${gi}`} x1={terms.length === 1 ? gateX : gateOut} y1={gy} x2={collectX} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    if (Math.abs(gy-pinY)>0.5) wires.push(<line key={`mid2_${gi}`} x1={collectX} y1={gy} x2={collectX} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    wires.push(<line key={`mid3_${gi}`} x1={collectX} y1={pinY} x2={finalX-24} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
  });

  if (form === "SOP") gates.push(<OrGate key="final" x={finalX} y={finalY} h={finalH} label="OR" />);
  else gates.push(<AndGate key="final" x={finalX} y={finalY} label="AND" />);

  wires.push(<line key="out" x1={finalOut} y1={finalY} x2={outXpos} y2={finalY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);

  const viewW = Math.min(W-20, outXpos+118);
  const viewH = Math.min(H-18, finalY + finalH + 74);
  return <svg viewBox={`32 42 ${viewW} ${viewH}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{dots}
    {wires}{gates}{labels}{branchDots}
    <circle cx={outXpos} cy={finalY} r="4.8" fill={C}/>
    <text x={outXpos+18} y={finalY+5} fontSize="17" fontWeight="900" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>
  </svg>;
}

function CompactTermCircuit({ terms, form="SOP" }) {
  const W = 560, H = 230, C = "#111", SW = 1.8;
  const gateX = 290;
  const yMid = 112;
  const inputGap = terms.length === 2 ? 34 : 30;
  const ys = terms.map((_,i)=> yMid + (i-(terms.length-1)/2)*inputGap);
  const x0 = 78;
  const notX = 160;
  const inputEnd = gateX - 18;
  const gateKind = form === "SOP" ? "and" : "or";
  const gateLabel = form === "SOP" ? "AND" : "OR";
  const gateOut = gateKind === "and" ? outX("and", gateX) : outX("or", gateX);
  const outEnd = Math.min(W-74, gateOut + 82);

  const dots=[];
  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) {
    dots.push(<circle key={`${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);
  }

  const wires=[]; const gates=[]; const labels=[];
  terms.forEach((t,i)=>{
    const y = ys[i];
    labels.push(<text key={`lbl_${i}`} x={x0-14} y={y+5} textAnchor="end" fontSize="14" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">{t.var}</text>);
    if (t.inv) {
      wires.push(<line key={`w1_${i}`} x1={x0} y1={y} x2={notX} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      gates.push(<NotGate key={`not_${i}`} x={notX} y={y} label="" />);
      wires.push(<line key={`w2_${i}`} x1={notX+NOT_W+6} y1={y} x2={inputEnd} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      labels.push(<text key={`nl_${i}`} x={notX+NOT_W+12} y={y-8} fontSize="11" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{t.var+"'"}</text>);
    } else {
      wires.push(<line key={`w_${i}`} x1={x0} y1={y} x2={inputEnd} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    }
  });

  if (gateKind === "and") gates.push(<AndGate key="gate" x={gateX} y={yMid} label={gateLabel} />);
  else gates.push(<OrGate key="gate" x={gateX} y={yMid} h={terms.length === 2 ? 24 : 30} label={gateLabel} />);

  wires.push(<line key="out" x1={gateOut} y1={yMid} x2={outEnd} y2={yMid} stroke={C} strokeWidth={SW} strokeLinecap="square" />);

  return <svg viewBox={`30 30 ${W-40} ${H-45}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{dots}
    {wires}{gates}{labels}
    <circle cx={outEnd} cy={yMid} r="4.8" fill={C}/>
    <text x={outEnd+18} y={yMid+5} fontSize="17" fontWeight="900" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>
  </svg>;
}

function SingleLiteralCircuit({ term, vars=ALL_VARS }) {
  const W = 430, H = 190, C = "#111", SW = 1.8;
  const y = 94, x0 = 74, xInv = 150, xOut = 340;
  const dots=[]; 
  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) dots.push(<circle key={`${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);
  const label = literalText(term);
  if (!term.inv) {
    return <svg viewBox="42 38 340 116" style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
      <rect width={W} height={H} fill="#f8f9ff" />{dots}
      <text x={x0-18} y={y+5} textAnchor="end" fontSize="15" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">{term.var}</text>
      <line x1={x0} y1={y} x2={xOut} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />
      <circle cx={x0} cy={y} r="4.2" fill={C}/><circle cx={xOut} cy={y} r="4.8" fill={C}/>
      <text x={xOut+10} y={y+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>
      <text x={xInv+46} y={y-22} fontSize="11" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{label}</text>
    </svg>;
  }
  const invOut = xInv + NOT_W;
  return <svg viewBox="42 38 352 116" style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{dots}
    <text x={x0-18} y={y+5} textAnchor="end" fontSize="15" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">{term.var}</text>
    <line x1={x0} y1={y} x2={xInv} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />
    <NotGate x={xInv} y={y} label="" />
    <line x1={invOut+6} y1={y} x2={xOut} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />
    <circle cx={x0} cy={y} r="4.2" fill={C}/><circle cx={xOut} cy={y} r="4.8" fill={C}/>
    <text x={xOut+10} y={y+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F</text>
    <text x={xInv+52} y={y-12} fontSize="11" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{label}</text>
  </svg>;
}

function ConstCircuit({ value }) {
  const W=520,H=180,y=90,x1=120,x2=390,C="#111",SW=1.7;
  const dots=[]; for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) dots.push(<circle key={`${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);
  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{dots}
    <text x={x1-18} y={y+5} textAnchor="end" fontSize="15" fontWeight="800" fontFamily="'Courier New',monospace" fill="#475569">{value?"VCC":"GND"}</text>
    <line x1={x1} y1={y} x2={x2} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />
    <circle cx={x1} cy={y} r="4.2" fill={C}/><circle cx={x2} cy={y} r="4.8" fill={C}/>
    <text x={x2+10} y={y+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F = {value}</text>
  </svg>;
}

function XorCircuit({ xorInfo }) {
  const W=560,H=210,C="#111",SW=1.8;
  const x0=92;
  const xGate=270;
  const yMid=104;
  const inputGap=32;
  const yA=yMid-inputGap/2;
  const yB=yMid+inputGap/2;
  const inputEnd=xGate-38;
  const bubble = !!xorInfo.invert;
  const label = bubble ? "XNOR" : "XOR";
  const gateOut = xGate + OR_W + (bubble ? 12 : 0);
  const outEnd = W-64;

  const dots=[];
  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) {
    dots.push(<circle key={`${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc"/>);
  }

  const used = xorInfo.used || ["A","B"];
  const a = used[0] || "A";
  const b = used[1] || "B";

  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{dots}

    <text x={x0-14} y={yA+5} textAnchor="end" fontSize="14" fontWeight="800" fontFamily="'Courier New',monospace">{a}</text>
    <text x={x0-14} y={yB+5} textAnchor="end" fontSize="14" fontWeight="800" fontFamily="'Courier New',monospace">{b}</text>

    <line x1={x0} y1={yA} x2={inputEnd} y2={yA} stroke={C} strokeWidth={SW} strokeLinecap="square"/>
    <line x1={x0} y1={yB} x2={inputEnd} y2={yB} stroke={C} strokeWidth={SW} strokeLinecap="square"/>

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [activePreset, setActivePreset] = useState(null);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const [showSplash, setShowSplash] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const exampleWrapRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 1200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onPointerDown = (e) => {
      if (!exampleWrapRef.current) return;
      if (!exampleWrapRef.current.contains(e.target)) setExampleOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const mainScrollRef = useRef(null);
  const snapTimerRef = useRef(null);

  const changeVarCount = useCallback((nextCount) => {
    setVarCount(nextCount);
    if (activePreset) {
      const built = buildPresetCells(activePreset, nextCount);
      setCells(built.cells);
    } else {
      setCells(Array(1 << nextCount).fill(0));
    }
  }, [activePreset]);

  const plans = useMemo(()=>buildPlans(cells, vars), [cells, vars]);

  // K-map and Circuit are separated:
  // - K-map always follows Optimization (Auto/SOP/POS) with Standard expression semantics.
  // - Circuit follows Implementation (Standard/NAND/NOR); NAND uses SOP, NOR uses POS internally.
  const kmapPlan = useMemo(()=>choosePlan(plans, optMode, "standard"), [plans, optMode]);
  const circuitPlan = useMemo(()=>choosePlan(plans, optMode, implMode), [plans, optMode, implMode]);
  const activePlan = tab === "circuit" ? circuitPlan : kmapPlan;
  const activeImpl = tab === "circuit" ? implMode : "standard";

  const displayExpr = activePlan.expr;
  const reco = useMemo(()=>recommendationSummary(plans, detectXor), [plans, detectXor]);
  const activeMetrics = estimateMetrics(activePlan, activeImpl);
  const breakdown = gateBreakdown(activePlan, activeImpl, plans.xor, detectXor);

  const mintermAt = useCallback((row, col) => cellToMinterm(row, col, cfg), [cfg]);
  const cycleCell = useCallback((m) => { setActivePreset(null); setCells(p => { const n=[...p]; n[m]=(n[m]+1)%3; return n; }); }, []);
  const fillAll = (val) => { setActivePreset(null); setCells(Array(cfg.total).fill(val)); };
  const fillRow = (row, val) => { setActivePreset(null); setCells(p => { const n=[...p]; cfg.colGray.forEach((_,col)=>{ n[cellToMinterm(row,col,cfg)] = val; }); return n; }); };
  const fillCol = (col, val) => { setActivePreset(null); setCells(p => { const n=[...p]; cfg.rowGray.forEach((_,row)=>{ n[cellToMinterm(row,col,cfg)] = val; }); return n; }); };
  const smartFillFromCell = (row, col) => {
    setSelectedGroup(null);
    const m = mintermAt(row, col);
    const next = (cells[m] + 1) % 3;
    if (editMode === "cell") cycleCell(m);
    else if (editMode === "row") fillRow(row, next);
    else if (editMode === "col") fillCol(col, next);
    else if (editMode === "all") fillAll(next);
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(()=>setToast(""), 1200);
  };

  const buildPresetCells = (kind, count) => {
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
  };

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

  const cellGroups = {};
  kmapPlan.groups.forEach((g,gi)=>g.forEach(m=>{
    if(!cellGroups[m]) cellGroups[m]=[];
    cellGroups[m].push({ group:g, index:gi, color:GROUP_COLORS[gi%GROUP_COLORS.length], key:stableKeyForGroup(kmapPlan.form, gi) });
  }));
  const cellSize = varCount === 2 ? 72 : 62;

  const handleMainScroll = (e) => {
    const y = e.currentTarget.scrollTop;
    setScrollY(y);
    if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
    snapTimerRef.current = setTimeout(() => {
      const el = mainScrollRef.current;
      if (!el) return;
      // Accidental tiny scrolls snap back to the full controls view.
      if (el.scrollTop > 0 && el.scrollTop < 34) {
        el.scrollTo({ top: 0, behavior: "smooth" });
      }
    }, 110);
  };

  const detectedPattern = plans.xor ? (plans.xor.invert ? "XNOR Detected" : "XOR Detected") : "—";
  const implLabel = `${activePlan.form} · ${activeImpl === "standard" ? "Standard" : activeImpl.toUpperCase()}`;
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

  const ExprLine = ({ title, form, items, expr, joiner, active }) => <div style={exprLine(active)}>
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

  const ResultCards = () => <div style={resultWrap()}>
    <div style={exprCard()}>
      <div style={cardLabel()}>EXPRESSIONS</div>
      <ExprLine title="SOP" form="SOP" items={sopItems} expr={sopExprText} joiner="+" active={activePlan.form === "SOP"} />
      <ExprLine title="POS" form="POS" items={posItems} expr={posExprText} joiner="·" active={activePlan.form === "POS"} />
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
        Gate {activeMetrics.gates} · Lit {activeMetrics.literals} · Depth {activeMetrics.depth} · Cost {implementationCost(activePlan, activeImpl)}
      </div>
    </div>
  </div>;

  const KmapTable = () => {
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
      return kmapSvgGroupLoopRects(g, gi, cfg, cellX, cellY, cellSize).map(rect => ({...rect, color, key, selected, dim}));
    });

    return <svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",maxWidth:w,height:"auto",display:"block",overflow:"visible"}}>
      <text x={labelW-8} y={20} textAnchor="end" fontSize="10.5" fontWeight="850" fill="#64748b">
        <tspan fill="#3b82f6">{cfg.rowLabel}</tspan><tspan>↓ </tspan><tspan fill="#16a34a">{cfg.colLabel}</tspan><tspan>→</tspan>
      </text>

      {cfg.colGray.map((cd,col)=><g key={`ch_${cd}`} onClick={()=>{ if (editMode === "col") fillCol(col, (cells[mintermAt(0,col)] + 1) % 3); }} style={{cursor:editMode==="col"?"pointer":"default"}}>
        <rect x={cellX(col)} y={0} width={cellSize} height={24} rx={8} fill={editMode==="col" ? "#fff" : "transparent"} stroke={editMode==="col" ? "#16a34a" : "transparent"} strokeWidth="1.8" />
        <text x={cellX(col)+cellSize/2} y={16} textAnchor="middle" fontSize="12" fontWeight="950" fill="#16a34a">{cd}</text>
      </g>)}

      {cfg.rowGray.map((ab,row)=><g key={`rh_${ab}`} onClick={()=>{ if (editMode === "row") fillRow(row, (cells[mintermAt(row,0)] + 1) % 3); }} style={{cursor:editMode==="row"?"pointer":"default"}}>
        <rect x={2} y={cellY(row)} width={46} height={cellSize} rx={8} fill={editMode==="row" ? "#fff" : "transparent"} stroke={editMode==="row" ? "#3b82f6" : "transparent"} strokeWidth="1.8" />
        <text x={25} y={cellY(row)+cellSize/2+4} textAnchor="middle" fontSize="12" fontWeight="950" fill="#3b82f6">{ab}</text>
      </g>)}

      {cfg.rowGray.map((_,row)=>cfg.colGray.map((__,col)=>{
        const m = mintermAt(row,col);
        const val = cells[m];
        const x = cellX(col);
        const y = cellY(row);
        return <g key={`cell_${row}_${col}`} onClick={()=>smartFillFromCell(row,col)} style={{cursor:"pointer"}}>
          <rect x={x} y={y} width={cellSize} height={cellSize} rx={8} fill={val===1?"#fff":val===2?"#fef9c3":"#f8fafc"} stroke="#cbd5e1" strokeWidth="1.5" />
          <text x={x+cellSize/2} y={y+cellSize/2+3} textAnchor="middle" fontSize="22" fontWeight="950" fill={val===1?"#1d4ed8":val===2?"#b45309":"#94a3b8"}>{val===2?"X":val}</text>
          <text x={x+cellSize/2} y={y+cellSize-9} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#94a3b8">m{m}</text>
        </g>;
      }))}

      {loopItems.map(item => <rect
        key={item.key + "_" + item.x + "_" + item.y}
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

  const ExampleFloatingMenu = () => <div style={exampleMenu()}>
    {exampleItems.map(([id, label]) => {
      const active = activePreset === id;
      return <button key={id} onClick={()=>applyPreset(id)} style={exampleItem(active)}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
        {active && <span style={{fontSize:"0.68rem",fontWeight:950,flex:"0 0 auto"}}>✓</span>}
      </button>;
    })}
  </div>;

  const OptionsPanel = () => <div style={controlPanel()}>
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
          {exampleOpen && <ExampleFloatingMenu />}
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
      if (selectedGroup && !e.target.closest?.('[data-group-control="1"]')) setSelectedGroup(null);
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

    <div ref={mainScrollRef} onScroll={handleMainScroll} style={{flex:1,display:"flex",flexDirection:"column",minHeight:0,overflow:"auto",scrollBehavior:"smooth"}}>
      <OptionsPanel />

      <div style={{flex:"1 0 auto",display:"flex",flexDirection:"column",minHeight:0}}>
      {tab === "kmap" && <div style={{flex:"1 0 auto",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-start",padding:"16px 14px 12px",gap:10,minHeight:"calc(100vh - 132px)"}}>
        <KmapTable />
        <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center",maxWidth:620}}>{kmapPlan.termsList.map((t,i)=>{
          const key = stableKeyForGroup(kmapPlan.form, i);
          const selected = selectedGroup === key;
          const color = GROUP_COLORS[i%GROUP_COLORS.length];
          return <button key={i} data-group-control="1" onClick={()=>setSelectedGroup(selected ? null : key)} style={groupChip(color, selected)}>
            <span style={{width:8,height:8,borderRadius:2,display:"inline-block",background:color}}/>
            <span style={{fontWeight:800,fontFamily:"monospace",color}}>{kmapPlan.form==="SOP"?sopTermExpr(t):posDisplayTermExpr(t)}</span>
          </button>;
        })}</div>
        <ResultCards />
      </div>}

      {tab === "circuit" && <div style={{flex:"1 0 auto",padding:"10px 12px",display:"flex",flexDirection:"column",gap:8,minHeight:"calc(100vh - 132px)"}}>
        <div style={{minHeight:300,flex:"1 1 300px",background:"#fff",borderRadius:10,border:"1px solid #e2e8f0",boxShadow:"0 1px 8px rgba(0,0,0,0.06)",overflow:"hidden"}}>
          <CircuitDiagram plan={circuitPlan} implMode={implMode} xorInfo={plans.xor} xorEnabled={detectXor} cells={cells} />
        </div>
        <ResultCards />
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

function gateBreakdown(plan, impl, xorInfo, xorEnabled) {
  if (impl === "standard" && xorEnabled && xorInfo) return { xor: xorInfo.invert ? 0 : 1, xnor: xorInfo.invert ? 1 : 0 };
  const nonConstTerms = plan.termsList.filter(t => t.length > 0);
  const inv = usedInverters(plan);
  if (plan.expr === "F = 0" || plan.expr === "F = 1") return { const:1 };
  if (impl === "nand") return { nand: inv + nonConstTerms.filter(t=>t.length>1).length + (nonConstTerms.length>1 ? 1 : 0) };
  if (impl === "nor") return { nor: inv + nonConstTerms.filter(t=>t.length>1).length + (nonConstTerms.length>1 ? 1 : 0) };
  const first = nonConstTerms.filter(t=>t.length>1).length;
  const final = nonConstTerms.length > 1 ? 1 : 0;
  return plan.form === "SOP" ? { inv, and:first, or:final } : { inv, or:first, and:final };
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
function controlGrid() {
  return {
    display:"grid",
    gridTemplateColumns:"minmax(180px,1fr) minmax(210px,1fr)",
    gap:"6px 8px",
    alignItems:"center"
  };
}
function advancedGrid() {
  return {
    marginTop:6,
    paddingTop:6,
    borderTop:"1px solid #cbd5e1",
    display:"grid",
    gridTemplateColumns:"minmax(180px,1fr) minmax(210px,1fr)",
    gap:"6px 8px",
    alignItems:"center"
  };
}

function compactToolbar() { return {background:"#e2e8f0",padding:"7px 10px",display:"flex",gap:8,alignItems:"center",flexWrap:"nowrap",flexShrink:0,borderBottom:"1px solid #cbd5e1"}; }
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
function exprTermsWrap() {
  return {
    display:"flex",
    flexWrap:"wrap",
    gap:"3px 5px",
    alignItems:"center",
    fontSize:"0.78rem",
    lineHeight:1.35,
    minWidth:0
  };
}
function exprFullText() {
  return {
    marginTop:3,
    fontFamily:"'Courier New',monospace",
    fontSize:"0.72rem",
    fontWeight:850,
    color:"#0f172a",
    whiteSpace:"normal",
    wordBreak:"break-word"
  };
}
function exprTermBtn(color, selected=false) {
  return {
    display:"inline-flex",
    alignItems:"center",
    gap:4,
    border:selected ? `1.5px solid ${color}` : "1px solid transparent",
    background:selected ? `${color}14` : "transparent",
    borderRadius:6,
    padding:"2px 4px",
    cursor:"pointer",
    fontFamily:"inherit"
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
function smallBtn(bg="#fff", color="#1e293b") { return {minHeight:31,padding:"6px 10px",background:bg,color,border:"1.5px solid #cbd5e1",borderRadius:9,cursor:"pointer",fontSize:"0.7rem",fontFamily:"inherit",fontWeight:900}; }
function presetBtn(active=false) {
  return {
    minHeight:31,
    minWidth:58,
    padding:"6px 10px",
    background:active ? "#2563eb" : "#fff",
    color:active ? "#fff" : "#1e293b",
    border:active ? "1.5px solid #1d4ed8" : "1.5px solid #cbd5e1",
    borderRadius:9,
    cursor:"pointer",
    fontSize:"0.7rem",
    fontFamily:"inherit",
    fontWeight:950,
    boxShadow:active ? "0 0 0 2px rgba(37,99,235,0.16)" : "none"
  };
}
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
    minWidth:0,
    width:"100%"
  };
}
function inlineAdvanced() {
  return {
    display:"flex",
    alignItems:"center",
    justifyContent:"space-between",
    gap:8,
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
function axisBtn(active, color) { return {minWidth:50,padding:"7px 8px",borderRadius:10,border:active?`2px solid ${color}`:"1.5px solid transparent",background:active?"#fff":"transparent",color,fontSize:"0.82rem",fontWeight:950,cursor:active?"pointer":"default"}; }
function btn(bg="#fff", color="#1e293b") { return {padding:"7px 14px",background:bg,color,border:"1.5px solid #cbd5e1",borderRadius:7,cursor:"pointer",fontSize:"0.76rem",fontFamily:"inherit",fontWeight:800}; }
function topBtn(active) { return {minHeight:31,padding:"6px 10px",borderRadius:9,border:"none",background:active?"#7c3aed":"#0f172a",color:active?"#fff":"#94a3b8",fontFamily:"inherit",fontSize:"0.7rem",fontWeight:900,cursor:"pointer"}; }
