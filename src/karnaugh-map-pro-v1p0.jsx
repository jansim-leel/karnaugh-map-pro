import { useState, useCallback, useMemo } from "react";

// ═══════════════════════════════════════════════════════════
//  K-MAP CORE
// ═══════════════════════════════════════════════════════════
const GRAY2 = ["00","01","11","10"];
const GROUP_COLORS = ["#e53935","#1e88e5","#43a047","#fb8c00","#8e24aa","#00897b"];
const VARS = ["A","B","C","D"];

const VALID_GROUPS = [
  [0],[1],[2],[3],[4],[5],[6],[7],[8],[9],[10],[11],[12],[13],[14],[15],
  [0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[12,13],[13,15],[15,14],[14,12],
  [8,9],[9,11],[11,10],[10,8],[0,4],[4,12],[12,8],[8,0],[1,5],[5,13],[13,9],[9,1],
  [3,7],[7,15],[15,11],[11,3],[2,6],[6,14],[14,10],[10,2],
  [0,2],[1,3],[4,6],[5,7],[8,10],[9,11],[12,14],[13,15],
  [0,1,3,2],[4,5,7,6],[12,13,15,14],[8,9,11,10],
  [0,4,12,8],[1,5,13,9],[3,7,15,11],[2,6,14,10],
  [0,1,5,4],[1,3,7,5],[3,2,6,7],[2,0,4,6],
  [4,5,13,12],[5,7,15,13],[7,6,14,15],[6,4,12,14],
  [0,4,8,12],[1,5,9,13],[3,7,11,15],[2,6,10,14],
  [0,2,8,10],[1,3,9,11],[4,6,12,14],[5,7,13,15],
  [0,1,8,9],[2,3,10,11],[4,5,12,13],[6,7,14,15],
  [0,1,2,3,4,5,6,7],[8,9,10,11,12,13,14,15],
  [0,1,4,5,8,9,12,13],[2,3,6,7,10,11,14,15],
  [0,2,4,6,8,10,12,14],[1,3,5,7,9,11,13,15],
  [0,1,2,3,8,9,10,11],[4,5,6,7,12,13,14,15],
  [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
];

function cellToMinterm(row, col) { return parseInt(GRAY2[row] + GRAY2[col], 2); }
function bitOf(m, bit) { return (m >> (3-bit)) & 1; }

function uniqGroupKey(g) { return [...g].sort((a,b)=>a-b).join(","); }

// target cells must be covered; helper cells are don't-care cells that may enlarge groups.
function findGroups(targets, helpers=[]) {
  if (!targets.length) return [];
  const targetSet = new Set(targets);
  const allowed = new Set([...targets, ...helpers]);
  const cands = VALID_GROUPS
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

function groupToSopTerms(group, vars=VARS) {
  return vars.map((v, bit) => {
    const vals = group.map(m => bitOf(m, bit));
    if (vals.every(x => x === 1)) return { var:v, inv:false };
    if (vals.every(x => x === 0)) return { var:v, inv:true };
    return null;
  }).filter(Boolean);
}

function groupToPosTerms(group, vars=VARS) {
  // Maxterm from grouped zero cells: bit 0 => A, bit 1 => A'
  return vars.map((v, bit) => {
    const vals = group.map(m => bitOf(m, bit));
    if (vals.every(x => x === 0)) return { var:v, inv:false };
    if (vals.every(x => x === 1)) return { var:v, inv:true };
    return null;
  }).filter(Boolean);
}

function literalText(t) { return t.inv ? `${t.var}'` : t.var; }
function sopTermExpr(terms) { return terms.length ? terms.map(literalText).join("·") : "1"; }
function posTermExpr(terms) { return terms.length ? `(${terms.map(literalText).join(" + ")})` : "0"; }

function detectAffineXor(cells, vars=VARS) {
  const known = cells.map((v,i)=>({v,i})).filter(x => x.v !== 2);
  if (known.length === 0) return null;
  const masks = [];
  for (let mask=1; mask<16; mask++) if (bitCount(mask) === 2) masks.push(mask);
  masks.sort((a,b) => bitCount(a)-bitCount(b));
  for (const mask of masks) {
    for (const invert of [0,1]) {
      const ok = known.every(({v,i}) => {
        let p = invert;
        for (let bit=0; bit<4; bit++) if (mask & (1 << (3-bit))) p ^= bitOf(i, bit);
        return p === v;
      });
      if (ok) {
        const used = vars.filter((_,bit)=> mask & (1 << (3-bit)));
        return { used, invert: !!invert, expr: used.join(" ⊕ "), kind: invert ? "XNOR/PARITY'" : "XOR/PARITY" };
      }
    }
  }
  return null;
}

function buildPlans(cells, vars=VARS) {
  const ones  = cells.map((v,i)=>v===1?i:-1).filter(i=>i>=0);
  const zeros = cells.map((v,i)=>v===0?i:-1).filter(i=>i>=0);
  const xs    = cells.map((v,i)=>v===2?i:-1).filter(i=>i>=0);

  const sopGroups = findGroups(ones, xs);
  const posGroups = findGroups(zeros, xs);
  const sopTerms = sopGroups.map(g => groupToSopTerms(g, vars));
  const posTerms = posGroups.map(g => groupToPosTerms(g, vars));

  const sop = {
    form:"SOP",
    target: ones,
    groups: sopGroups,
    termsList: sopTerms,
    expr: ones.length === 0 ? "F = 0" : ones.length + xs.length === 16 ? "F = 1" : "F = " + sopTerms.map(sopTermExpr).join(" + "),
  };
  const pos = {
    form:"POS",
    target: zeros,
    groups: posGroups,
    termsList: posTerms,
    expr: zeros.length === 0 ? "F = 1" : zeros.length + xs.length === 16 ? "F = 0" : "F = " + posTerms.map(posTermExpr).join(" · "),
  };
  sop.metrics = estimateMetrics(sop, "standard");
  pos.metrics = estimateMetrics(pos, "standard");
  const xor = detectAffineXor(cells, vars);
  return { ones, zeros, xs, sop, pos, xor };
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
const AND_W = 58, AND_H = 22, OR_W = 68;
const NOT_W = 34, NOT_H = 12;

function AndGate({ x, y, label="AND", bubble=false }) {
  const out = x + AND_W*0.48 + AND_H;
  return <g>
    <path d={`M${x},${y-AND_H} H${x+AND_W*0.48} A${AND_H},${AND_H} 0 0,1 ${x+AND_W*0.48},${y+AND_H} H${x} Z`} fill="#fff" stroke="#111" strokeWidth="1.8" />
    {bubble && <circle cx={out+4} cy={y} r="4" fill="#fff" stroke="#111" strokeWidth="1.8" />}
    <text x={x+AND_W*0.25} y={y+4} textAnchor="middle" fontSize="8.4" fontFamily="Arial,sans-serif" fontWeight="800">{label}</text>
  </g>;
}
function OrGate({ x, y, h=24, label="OR", bubble=false }) {
  const inset = OR_W*0.23;
  const out = x + OR_W;
  return <g>
    <path d={`M${x},${y-h} Q${x+OR_W*0.56},${y-h} ${x+OR_W},${y} Q${x+OR_W*0.56},${y+h} ${x},${y+h} Q${x+inset},${y} ${x},${y-h} Z`} fill="#fff" stroke="#111" strokeWidth="1.8" />
    {bubble && <circle cx={out+4} cy={y} r="4" fill="#fff" stroke="#111" strokeWidth="1.8" />}
    <text x={x+OR_W*0.45} y={y+4} textAnchor="middle" fontSize="8.4" fontFamily="Arial,sans-serif" fontWeight="800">{label}</text>
  </g>;
}
function NotGate({ x, y, label="INV" }) {
  return <g>
    <polygon points={`${x},${y-NOT_H} ${x+NOT_W-7},${y} ${x},${y+NOT_H}`} fill="#fff" stroke="#111" strokeWidth="1.8" />
    <circle cx={x+NOT_W-3.5} cy={y} r="3.3" fill="#fff" stroke="#111" strokeWidth="1.8" />
    <text x={x+NOT_W/2-4} y={y+3.2} textAnchor="middle" fontSize="6.6" fontFamily="Arial,sans-serif" fontWeight="800">{label}</text>
  </g>;
}
function XorGate({ x, y, label="XOR" }) {
  return <g>
    <path d={`M${x-7},${y-24} Q${x+8},${y} ${x-7},${y+24}`} fill="none" stroke="#111" strokeWidth="1.5" />
    <OrGate x={x} y={y} h={24} label={label} />
  </g>;
}
function outX(kind, x, impl="standard") {
  if (kind === "or") return x + OR_W + (impl === "nor" ? 8 : 0);
  if (kind === "and") return x + AND_W*0.48 + AND_H + (impl === "nand" ? 8 : 0);
  if (kind === "xor") return x + OR_W;
  return x;
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
  const form = implMode === "nand" ? "SOP" : implMode === "nor" ? "POS" : plan.form;

  const isZero = plan.expr === "F = 0";
  const isOne = plan.expr === "F = 1";
  if (isZero || isOne) return <ConstCircuit value={isOne ? 1 : 0} />;

  const SW = 1.7, C = "#111";
  const PAD_L = 58, PAD_T = 28, PAD_R = 88, PAD_B = 36;
  const ROW_GAP = 56, INV_OFFSET = 26;
  // Columns are deliberately separated so NAND/NOR inverter symbols, signal trunks,
  // product gates, and final gates do not visually collide.
  const NOT_X = implMode === "standard" ? 170 : 310;
  const RAIL_END = implMode === "standard" ? 470 : 740;
  const X_STAGE = implMode === "standard" ? 760 : 1180;
  const TERM_GAP = 78, TOP_GAP = 118;
  const railY = {}, invY = {};
  VARS.forEach((v,i)=>{ railY[v]=PAD_T+24+i*ROW_GAP; invY[v]=railY[v]+INV_OFFSET; });
  const termY = termsList.map((_,i)=> PAD_T + VARS.length*ROW_GAP + TOP_GAP + i*TERM_GAP);
  const hasFinal = termsList.length > 1 || implMode === "nand" || implMode === "nor";
  const X_FINAL = X_STAGE + (implMode === "standard" ? 330 : 520);
  const finalY = termY.length ? (termY[0]+termY[termY.length-1])/2 : 250;
  const finalH = Math.max(26, termsList.length * 8 + 12);
  const X_OUT = X_FINAL + 115;
  const W = X_OUT + PAD_R;
  const H = Math.max(finalY + finalH + 60, termY[termY.length-1] + 70) + PAD_B;

  const usedVarSet = new Set();
  const needsInv = new Set();
  termsList.forEach(ts => ts.forEach(t=>{ usedVarSet.add(t.var); if (t.inv) needsInv.add(t.var); }));

  const layers = { grid:[], bus:[], wires:[], gates:[], dots:[], labels:[] };
  const dots = new Set();
  const addDot = (x,y)=>dots.add(`${Math.round(x)},${Math.round(y)}`);
  for (let xi=1; xi<W/24; xi++) for (let yi=1; yi<H/24; yi++) layers.grid.push(<circle key={`g${xi}_${yi}`} cx={xi*24} cy={yi*24} r="0.65" fill="#c8d0dc" />);

  VARS.forEach(v => {
    const y = railY[v], active = usedVarSet.has(v);
    layers.bus.push(<line key={`rail_${v}`} x1={PAD_L} y1={y} x2={RAIL_END} y2={y} stroke={active?C:"#cbd5e1"} strokeWidth={active?SW:1.15} strokeLinecap="square" />);
    layers.labels.push(<text key={`lbl_${v}`} x={PAD_L-10} y={y+4.5} textAnchor="end" fontSize="13.5" fontFamily="'Courier New',monospace" fontWeight="800" fill={active?"#1e293b":"#94a3b8"}>{v}</text>);
    if (needsInv.has(v)) {
      const by = invY[v], branchX = NOT_X - (implMode === "standard" ? 20 : 55);
      layers.bus.push(<line key={`ibh_${v}`} x1={branchX-13} y1={y} x2={branchX} y2={y} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      layers.bus.push(<line key={`ibv_${v}`} x1={branchX} y1={y} x2={branchX} y2={by} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      layers.bus.push(<line key={`iin_${v}`} x1={branchX} y1={by} x2={NOT_X} y2={by} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      const invOut = implMode === "nand" ? outX("and", NOT_X, "nand") : implMode === "nor" ? outX("or", NOT_X, "nor") : NOT_X + NOT_W;
      layers.gates.push(implMode === "nand" ? <AndGate key={`not_${v}`} x={NOT_X} y={by} label="NAND" bubble /> : implMode === "nor" ? <OrGate key={`not_${v}`} x={NOT_X} y={by} h={14} label="NOR" bubble /> : <NotGate key={`not_${v}`} x={NOT_X} y={by} />);
      layers.bus.push(<line key={`iout_${v}`} x1={invOut + 6} y1={by} x2={RAIL_END} y2={by} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      layers.labels.push(<text key={`ilbl_${v}`} x={NOT_X+NOT_W+6} y={by-5} fontSize="10" fontFamily="'Courier New',monospace" fontWeight="800" fill="#92400e">{v+"'"}</text>);
      addDot(branchX, y);
    }
  });

  const signalUses = new Map();
  const signalKey = t => `${t.var}_${t.inv?"INV":"RAW"}`;
  const srcY = key => key.endsWith("INV") ? invY[key[0]] : railY[key[0]];

  termsList.forEach((terms, gi) => {
    const gy = termY[gi], n = terms.length;
    const spread = n <= 1 ? 0 : Math.min((n-1)*10, 32);
    const offs = terms.map((_,ti)=> n<=1 ? 0 : -spread/2 + ti*spread/(n-1));
    terms.forEach((t,ti)=>{
      const key=signalKey(t), pinY=gy+offs[ti];
      if (!signalUses.has(key)) signalUses.set(key, []);
      signalUses.get(key).push({ gi, ti, pinY });
    });

    const firstKind = implMode === "nand" ? "nand" : implMode === "nor" ? "nor" : form === "SOP" ? "and" : "or";
    const gateLabel = implMode === "nand" ? "NAND" : implMode === "nor" ? "NOR" : form === "SOP" ? "AND" : "OR";
    if (n === 1 && implMode === "standard") {
      // Direct single-literal connection: no BUF gate, wire only.
    }
    else if (firstKind === "nand") layers.gates.push(<AndGate key={`nand_${gi}`} x={X_STAGE} y={gy} label="NAND" bubble />);
    else if (firstKind === "nor") layers.gates.push(<OrGate key={`nor_${gi}`} x={X_STAGE} y={gy} h={22} label="NOR" bubble />);
    else if (firstKind === "and") layers.gates.push(<AndGate key={`and_${gi}`} x={X_STAGE} y={gy} label={gateLabel} />);
    else layers.gates.push(<OrGate key={`or_${gi}`} x={X_STAGE} y={gy} h={22} label={gateLabel} />);

    const termText = form === "SOP" ? sopTermExpr(terms) : posTermExpr(terms);
    layers.labels.push(<text key={`tl_${gi}`} x={X_STAGE} y={gy-30} fontSize="10.5" fontFamily="'Courier New',monospace" fontWeight="800" fill={GROUP_COLORS[gi%GROUP_COLORS.length]}>{termText}</text>);
  });

  const orderedKeys = VARS.flatMap(v=>[`${v}_RAW`,`${v}_INV`]).filter(k=>signalUses.has(k));
  const trunkX = {};
  orderedKeys.forEach((k,i)=>{ trunkX[k] = RAIL_END + 18 + i*24; });
  orderedKeys.forEach(key => {
    const uses = signalUses.get(key), x = trunkX[key], sy = srcY(key);
    const minY = Math.min(sy, ...uses.map(u=>u.pinY)), maxY = Math.max(sy, ...uses.map(u=>u.pinY));
    if (x > RAIL_END) layers.wires.push(<line key={`re_${key}`} x1={RAIL_END} y1={sy} x2={x} y2={sy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    layers.wires.push(<line key={`tr_${key}`} x1={x} y1={minY} x2={x} y2={maxY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    addDot(x, sy);
    uses.forEach(u => {
      layers.wires.push(<line key={`br_${key}_${u.gi}_${u.ti}`} x1={x} y1={u.pinY} x2={X_STAGE-2} y2={u.pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      addDot(x, u.pinY);
    });
  });

  const firstOut = (terms, gy) => {
    if (implMode === "nand") return outX("and", X_STAGE, "nand");
    if (implMode === "nor") return outX("or", X_STAGE, "nor");
    if (terms.length === 1) return X_STAGE;
    return form === "SOP" ? outX("and", X_STAGE) : outX("or", X_STAGE);
  };

  if (hasFinal) {
    termsList.forEach((terms,gi)=>{
      const gy = termY[gi];
      const pinSpread = Math.min((termsList.length-1)*12, (finalH-5)*2);
      const pinY = finalY + (termsList.length===1 ? 0 : -pinSpread/2 + gi*pinSpread/(termsList.length-1));
      const collectX = X_FINAL - 44 - (termsList.length-1-gi)*8;
      layers.wires.push(<line key={`fh_${gi}`} x1={firstOut(terms, gy)} y1={gy} x2={collectX} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      if (Math.abs(gy-pinY)>0.5) layers.wires.push(<line key={`fv_${gi}`} x1={collectX} y1={gy} x2={collectX} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      layers.wires.push(<line key={`fp_${gi}`} x1={collectX} y1={pinY} x2={X_FINAL-2} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    });
    if (implMode === "nand") layers.gates.push(<AndGate key="final" x={X_FINAL} y={finalY} label="NAND" bubble />);
    else if (implMode === "nor") layers.gates.push(<OrGate key="final" x={X_FINAL} y={finalY} h={finalH} label="NOR" bubble />);
    else if (form === "SOP") layers.gates.push(<OrGate key="final" x={X_FINAL} y={finalY} h={finalH} label="OR" />);
    else layers.gates.push(<AndGate key="final" x={X_FINAL} y={finalY} label="AND" />);
    const fx = implMode === "nand" ? outX("and", X_FINAL, "nand") : implMode === "nor" ? outX("or", X_FINAL, "nor") : form === "SOP" ? outX("or", X_FINAL) : outX("and", X_FINAL);
    layers.wires.push(<line key="out" x1={fx} y1={finalY} x2={X_OUT} y2={finalY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    layers.gates.push(<g key="f"><circle cx={X_OUT} cy={finalY} r="4.8" fill={C}/><text x={X_OUT+10} y={finalY+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F</text></g>);
  } else {
    const gy = termY[0], fx = firstOut(termsList[0], gy);
    layers.wires.push(<line key="single" x1={fx} y1={gy} x2={X_OUT} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    layers.gates.push(<g key="f"><circle cx={X_OUT} cy={gy} r="4.8" fill={C}/><text x={X_OUT+10} y={gy+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace" fill="#1e293b">F</text></g>);
  }

  dots.forEach(k=>{ const [x,y]=k.split(",").map(Number); layers.dots.push(<circle key={`d_${k}`} cx={x} cy={y} r="3.6" fill={C}/>); });

  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />
    {layers.grid}{layers.bus}{layers.wires}{layers.gates}{layers.dots}{layers.labels}
    <text x={W-18} y={H-16} textAnchor="end" fontSize="10" fontFamily="Arial,sans-serif" fill="#64748b">{form} · {implMode.toUpperCase()} · trunked branches</text>
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
  const W=760,H=300,C="#111",SW=1.7, x0=90, xGate=260;
  const ys = xorInfo.used.map((_,i)=>80+i*48);
  const gates=[]; const wires=[]; const labels=[];
  xorInfo.used.forEach((v,i)=>{ labels.push(<text key={`l${v}`} x={x0-12} y={ys[i]+5} textAnchor="end" fontSize="14" fontWeight="800" fontFamily="'Courier New',monospace">{v}</text>); wires.push(<line key={`w${v}`} x1={x0} y1={ys[i]} x2={xGate} y2={ys[i]} stroke={C} strokeWidth={SW}/>); });
  let lastY = ys[0], lastX = xGate;
  for (let i=1;i<ys.length;i++) {
    const gy = (lastY + ys[i]) / 2;
    gates.push(<XorGate key={`xor${i}`} x={lastX} y={gy} label={i===ys.length-1 && xorInfo.invert ? "XNOR" : "XOR"} />);
    wires.push(<line key={`a${i}`} x1={lastX} y1={lastY} x2={lastX} y2={gy-10} stroke={C} strokeWidth={SW}/>);
    wires.push(<line key={`b${i}`} x1={lastX} y1={ys[i]} x2={lastX} y2={gy+10} stroke={C} strokeWidth={SW}/>);
    lastX += 135; lastY = gy;
    wires.push(<line key={`o${i}`} x1={lastX-67} y1={gy} x2={lastX} y2={gy} stroke={C} strokeWidth={SW}/>);
  }
  wires.push(<line key="out" x1={lastX} y1={lastY} x2={W-120} y2={lastY} stroke={C} strokeWidth={SW}/>);
  gates.push(<g key="f"><circle cx={W-120} cy={lastY} r="4.8" fill={C}/><text x={W-108} y={lastY+5} fontSize="16" fontWeight="800" fontFamily="'Courier New',monospace">F</text></g>);
  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W} height={H} fill="#f8f9ff" />{wires}{gates}{labels}
    <text x={W-18} y={H-16} textAnchor="end" fontSize="10" fontFamily="Arial,sans-serif" fill="#64748b">Detected {xorInfo.kind}</text>
  </svg>;
}

// ═══════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════
export default function KarnaughMapApp() {
  const [cells, setCells] = useState(Array(16).fill(0));
  const [tab, setTab] = useState("kmap");
  const [optMode, setOptMode] = useState("auto"); // sop | pos | auto
  const [implMode, setImplMode] = useState("standard"); // standard | nand | nor
  const [detectXor, setDetectXor] = useState(true);
  const [editMode, setEditMode] = useState("cell"); // cell | row | col

  const plans = useMemo(()=>buildPlans(cells, VARS), [cells]);
  const plan = useMemo(()=>choosePlan(plans, optMode, implMode), [plans, optMode, implMode]);
  const displayExpr = implMode === "standard" && detectXor && plans.xor ? `F = ${plans.xor.invert ? "(" + plans.xor.expr + ")'" : plans.xor.expr}` : plan.expr;
  const metrics = estimateMetrics(plan, implMode);
  const reco = useMemo(()=>recommendationSummary(plans, detectXor), [plans, detectXor]);

  const cycleCell = useCallback((m) => setCells(p => { const n=[...p]; n[m]=(n[m]+1)%3; return n; }), []);
  const fillAll = (val) => setCells(Array(16).fill(val));
  const fillRow = (row, val) => setCells(p => { const n=[...p]; GRAY2.forEach((_,col)=>{ n[cellToMinterm(row,col)] = val; }); return n; });
  const fillCol = (col, val) => setCells(p => { const n=[...p]; GRAY2.forEach((_,row)=>{ n[cellToMinterm(row,col)] = val; }); return n; });
  const smartFillFromCell = (row, col) => {
    const m = cellToMinterm(row, col);
    const next = (cells[m] + 1) % 3;
    if (editMode === "cell") cycleCell(m);
    else if (editMode === "row") fillRow(row, next);
    else if (editMode === "col") fillCol(col, next);
  };

  const cellColors = {};
  plan.groups.forEach((g,gi)=>g.forEach(m=>{ if(!cellColors[m]) cellColors[m]=[]; cellColors[m].push(GROUP_COLORS[gi%GROUP_COLORS.length]); }));

  return <div style={{height:"100vh",display:"flex",flexDirection:"column",background:"#f1f5f9",fontFamily:"'Inter','Segoe UI',sans-serif",color:"#1e293b",overflow:"hidden"}}>
    <div style={{background:"#1e293b",padding:"9px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0,flexWrap:"wrap"}}>
      <div><div style={{fontSize:"0.9rem",fontWeight:900,color:"#f8fafc",letterSpacing:"0.08em"}}>KARNAUGH MAP PRO</div><div style={{fontSize:"0.58rem",color:"#64748b",letterSpacing:"0.08em"}}>SOP · POS · NAND · NOR · XOR/XNOR</div></div>
      <PillGroup value={tab} setValue={setTab} items={[["kmap","K-Map"],["circuit","Circuit"]]} />
      <PillGroup value={optMode} setValue={setOptMode} disabled={implMode!=="standard"} items={[["auto","Auto"],["sop","SOP"],["pos","POS"]]} />
      <PillGroup value={implMode} setValue={setImplMode} items={[["standard","Standard"],["nand","NAND Only"],["nor","NOR Only"]]} />
      <PillGroup value={editMode} setValue={setEditMode} items={[["cell","Cell"],["row","Row"],["col","Column"]]} />
      <button onClick={()=>setDetectXor(v=>!v)} style={topBtn(detectXor)}>{detectXor?"XOR/XNOR ON":"XOR/XNOR OFF"}</button>
      <div style={{marginLeft:"auto",background:"#0f172a",borderRadius:8,padding:"6px 12px",fontSize:"0.82rem",fontWeight:800,fontFamily:"'Courier New',monospace",color:"#60a5fa",maxWidth:"100%",whiteSpace:"normal",overflow:"visible",textOverflow:"clip",lineHeight:1.55,wordBreak:"keep-all",flexBasis:"100%"}}>{displayExpr}</div>
    </div>

    <div style={{background:"#e2e8f0",padding:"6px 14px",display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",fontSize:"0.72rem",fontWeight:800,color:"#334155"}}>
      <span>{plan.form} selected{implMode!=="standard" ? " (forced by implementation)" : ""}</span><span>·</span><span>{metricLine(plan, implMode)}</span><span>·</span><span style={{color:"#0f766e"}}>Recommended: {reco.best.name} (Cost {reco.best.cost})</span>{plans.xor && <><span>·</span><span style={{color:"#7c3aed"}}>Pattern: {plans.xor.invert ? "XNOR" : "XOR"} {plans.xor.expr}</span></>}
    </div>

    <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
      {tab === "kmap" && <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:12,gap:10,overflow:"auto"}}>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center"}}>
          <button onClick={()=>fillAll(0)} style={btn()}>All 0</button><button onClick={()=>fillAll(2)} style={btn("#facc15","#713f12")}>All X</button><button onClick={()=>fillAll(1)} style={btn("#3b82f6","#fff")}>All 1</button>
        </div>
        <table style={{borderCollapse:"separate",borderSpacing:3}}>
          <thead><tr>
            <td style={{width:76,height:32,textAlign:"right",paddingRight:6,fontSize:"0.68rem",color:"#64748b"}}><span style={{color:"#3b82f6"}}>AB</span>↓ <span style={{color:"#16a34a"}}>CD</span>→</td>
            {GRAY2.map((cd,col)=><th key={cd} style={{width:66,textAlign:"center",color:"#16a34a",fontSize:"0.75rem",fontWeight:800}}><button onClick={()=>{ if (editMode === "col") fillCol(col, (cells[cellToMinterm(0,col)] + 1) % 3); }} style={axisBtn(editMode==="col", "#16a34a")}>{cd}</button></th>)}
          </tr></thead>
          <tbody>{GRAY2.map((ab,row)=><tr key={ab}>
            <th style={{textAlign:"center",color:"#3b82f6",fontSize:"0.75rem",fontWeight:800}}><button onClick={()=>{ if (editMode === "row") fillRow(row, (cells[cellToMinterm(row,0)] + 1) % 3); }} style={axisBtn(editMode==="row", "#3b82f6")}>{ab}</button></th>
            {GRAY2.map((_,col)=>{ const m=cellToMinterm(row,col), val=cells[m], c0=(cellColors[m]||[])[0]; return <td key={col} style={{padding:0}}><button onClick={()=>smartFillFromCell(row, col)} style={{width:62,height:62,border:c0?`2.5px solid ${c0}`:"1.5px solid #cbd5e1",borderRadius:6,background:val===1?(c0?c0+"22":"#dbeafe"):val===2?"#fef9c3":"#fff",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,transition:"all 0.12s"}}><span style={{fontSize:"1.3rem",fontWeight:900,lineHeight:1,color:val===1?(c0||"#3b82f6"):val===2?"#b45309":"#94a3b8"}}>{val===2?"X":val}</span><span style={{fontSize:"0.55rem",color:"#94a3b8",fontFamily:"monospace"}}>m{m}</span></button></td>; })}
          </tr>)}</tbody>
        </table>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center",maxWidth:520}}>{plan.termsList.map((t,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:5,background:"#fff",border:`1.5px solid ${GROUP_COLORS[i%GROUP_COLORS.length]}`,borderRadius:6,padding:"4px 10px",fontSize:"0.75rem"}}><span style={{width:8,height:8,borderRadius:2,display:"inline-block",background:GROUP_COLORS[i%GROUP_COLORS.length]}}/><span style={{fontWeight:800,fontFamily:"monospace",color:GROUP_COLORS[i%GROUP_COLORS.length]}}>{plan.form==="SOP"?sopTermExpr(t):posTermExpr(t)}</span></div>)}</div>
      </div>}

      {tab === "circuit" && <div style={{flex:1,padding:"12px 16px",display:"flex",flexDirection:"column",minHeight:0}}>
        <div style={{flex:1,background:"#fff",borderRadius:10,border:"1px solid #e2e8f0",boxShadow:"0 1px 8px rgba(0,0,0,0.06)",overflow:"hidden",minHeight:0}}>
          <CircuitDiagram plan={plan} implMode={implMode} xorInfo={plans.xor} xorEnabled={detectXor} cells={cells} />
        </div>
      </div>}
    </div>


    <div style={{background:"#1e293b",padding:"5px 16px",fontSize:"0.6rem",color:"#64748b",letterSpacing:"0.05em",flexShrink:0}}>0 = FALSE · 1 = TRUE · X = DON'T CARE · Cell: one cell · Row/Column: tap any cell to cycle the whole line</div>
  </div>;
}

function PillGroup({ value, setValue, items, disabled=false }) {
  return <div style={{display:"flex",gap:2,background:disabled?"#172033":"#0f172a",borderRadius:8,padding:3,opacity:disabled?0.58:1}}>{items.map(([id,lbl])=>{
    const active = value===id;
    return <button key={id} disabled={disabled} onClick={()=>!disabled && setValue(id)} style={{padding:"6px 10px",borderRadius:6,border:"none",background:active?"#3b82f6":"transparent",color:active?"#fff":"#94a3b8",fontFamily:"inherit",fontSize:"0.72rem",fontWeight:800,cursor:disabled?"not-allowed":"pointer"}}>{lbl}</button>;
  })}</div>;
}
function FillSheet({ target, onApply, onClose }) {
  return <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.34)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:50}}>
    <div onClick={(e)=>e.stopPropagation()} style={{width:"100%",maxWidth:520,background:"#fff",borderRadius:"18px 18px 0 0",boxShadow:"0 -8px 24px rgba(15,23,42,0.22)",padding:"18px 18px 22px"}}>
      <div style={{fontSize:"0.82rem",fontWeight:900,color:"#64748b",marginBottom:6}}>Fill {target.type === "row" ? "Row" : "Column"}</div>
      <div style={{fontSize:"1.05rem",fontWeight:950,color:"#1e293b",marginBottom:14}}>{target.label}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        <button onClick={()=>onApply(0)} style={sheetBtn("#f8fafc", "#334155")}>All 0</button>
        <button onClick={()=>onApply(2)} style={sheetBtn("#fef9c3", "#92400e")}>All X</button>
        <button onClick={()=>onApply(1)} style={sheetBtn("#dbeafe", "#1d4ed8")}>All 1</button>
      </div>
      <button onClick={onClose} style={{marginTop:12,width:"100%",padding:"12px",border:"none",borderRadius:12,background:"#e2e8f0",fontWeight:900,color:"#475569"}}>Cancel</button>
    </div>
  </div>;
}
function sheetBtn(bg, color) { return {padding:"16px 8px",border:"1.5px solid #cbd5e1",borderRadius:14,background:bg,color,fontSize:"0.95rem",fontWeight:950,cursor:"pointer"}; }
function axisBtn(active, color) { return {minWidth:50,padding:"7px 8px",borderRadius:10,border:active?`2px solid ${color}`:"1.5px solid transparent",background:active?"#fff":"transparent",color,fontSize:"0.82rem",fontWeight:950,cursor:active?"pointer":"default"}; }

function btn(bg="#fff", color="#1e293b") { return {padding:"7px 14px",background:bg,color,border:"1.5px solid #cbd5e1",borderRadius:7,cursor:"pointer",fontSize:"0.76rem",fontFamily:"inherit",fontWeight:800}; }
function topBtn(active) { return {padding:"6px 10px",borderRadius:8,border:"none",background:active?"#7c3aed":"#0f172a",color:active?"#fff":"#94a3b8",fontFamily:"inherit",fontSize:"0.72rem",fontWeight:900,cursor:"pointer"}; }
function bitCount(n) { let c=0; while(n){c+=n&1;n>>=1;} return c; }
