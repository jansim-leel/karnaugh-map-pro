import { useState, useCallback, useMemo, useRef } from "react";

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
const AND_W = 62, AND_H = 23, OR_W = 82;
const NOT_W = 38, NOT_H = 13;

function AndGate({ x, y, label="AND", bubble=false }) {
  const bodyW = AND_W * 0.54;
  const out = x + bodyW + AND_H;
  const bubbleR = 4.2;
  return <g>
    <path
      d={`M${x},${y-AND_H} H${x+bodyW} A${AND_H},${AND_H} 0 0,1 ${x+bodyW},${y+AND_H} H${x} Z`}
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
  if (implMode === "standard" && termsList.length === 1 && termsList[0]?.length >= 2 && termsList[0]?.length <= 3) {
    return <CompactTermCircuit terms={termsList[0]} form={plan.form} />;
  }
  if (
    implMode === "standard" &&
    termsList.length >= 2 &&
    termsList.every(t => t.length >= 1 && t.length <= 4)
  ) {
    return <TextbookTwoLevelCircuit termsList={termsList} form={plan.form} vars={vars} />;
  }

  const SW = 1.7, C = "#111";
  const PAD_L = 58, PAD_T = 28, PAD_R = 88, PAD_B = 36;
  const ROW_GAP = 48, INV_OFFSET = 23;
  // Columns are deliberately separated so NAND/NOR inverter symbols, signal trunks,
  // product gates, and final gates do not visually collide.
  const NOT_X = implMode === "standard" ? 124 : 210;
  const RAIL_END = implMode === "standard" ? 270 : 440;
  const X_STAGE = implMode === "standard" ? 455 : 780;
  const TERM_GAP = 64, TOP_GAP = 86;
  const railY = {}, invY = {};
  vars.forEach((v,i)=>{ railY[v]=PAD_T+24+i*ROW_GAP; invY[v]=railY[v]+INV_OFFSET; });
  const termY = termsList.map((_,i)=> PAD_T + vars.length*ROW_GAP + TOP_GAP + i*TERM_GAP);
  const hasFinal = termsList.length > 1 || implMode === "nand" || implMode === "nor";
  const X_FINAL = X_STAGE + (implMode === "standard" ? 185 : 330);
  const finalY = termY.length ? (termY[0]+termY[termY.length-1])/2 : 250;
  const finalH = Math.max(26, termsList.length * 8 + 12);
  const X_OUT = X_FINAL + 118;
  const W = X_OUT + PAD_R;
  const H = Math.max(finalY + finalH + 60, termY[termY.length-1] + 70) + PAD_B;

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
      mark([branchX-13,y],[branchX,by],[NOT_X,by],[RAIL_END,by]);
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
  const keyVar = key => key.split("_")[0];
  const srcY = key => key.endsWith("INV") ? invY[keyVar(key)] : railY[keyVar(key)];

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
    mark([X_STAGE-4, gy-34], [outX(firstKind === "or" || firstKind === "nor" ? "or" : "and", X_STAGE, implMode), gy+34]);
    if (n === 1 && implMode === "standard") {
      // Direct single-literal connection: no BUF gate, wire only.
    }
    else if (firstKind === "nand") layers.gates.push(<AndGate key={`nand_${gi}`} x={X_STAGE} y={gy} label="NAND" bubble />);
    else if (firstKind === "nor") layers.gates.push(<OrGate key={`nor_${gi}`} x={X_STAGE} y={gy} h={22} label="NOR" bubble />);
    else if (firstKind === "and") layers.gates.push(<AndGate key={`and_${gi}`} x={X_STAGE} y={gy} label={gateLabel} />);
    else layers.gates.push(<OrGate key={`or_${gi}`} x={X_STAGE} y={gy} h={22} label={gateLabel} />);

    const termText = form === "SOP" ? sopTermExpr(terms) : posTermExpr(terms);
    layers.labels.push(<text key={`tl_${gi}`} x={X_STAGE} y={gy-28} fontSize="10.5" fontFamily="'Courier New',monospace" fontWeight="800" fill={GROUP_COLORS[gi%GROUP_COLORS.length]}>{termText}</text>);
  });

  const orderedKeys = vars.flatMap(v=>[`${v}_RAW`,`${v}_INV`]).filter(k=>signalUses.has(k));
  const trunkX = {};
  orderedKeys.forEach((k,i)=>{ trunkX[k] = RAIL_END + 20 + i*34; });
  orderedKeys.forEach(key => {
    const uses = signalUses.get(key), x = trunkX[key], sy = srcY(key);
    const minY = Math.min(sy, ...uses.map(u=>u.pinY)), maxY = Math.max(sy, ...uses.map(u=>u.pinY));
    mark([RAIL_END,sy],[x,minY],[x,maxY],[X_STAGE, maxY]);
    if (x > RAIL_END) layers.wires.push(<line key={`re_${key}`} x1={RAIL_END} y1={sy} x2={x} y2={sy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    layers.wires.push(<line key={`tr_${key}`} x1={x} y1={minY} x2={x} y2={maxY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    addDot(x, sy);
    uses.forEach(u => {
      layers.wires.push(<line key={`br_${key}_${u.gi}_${u.ti}`} x1={x} y1={u.pinY} x2={X_STAGE-24} y2={u.pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
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
      const pinSpread = Math.min((termsList.length-1)*12, (finalH-5)*2);
      const pinY = finalY + (termsList.length===1 ? 0 : -pinSpread/2 + gi*pinSpread/(termsList.length-1));
      const collectX = X_FINAL - 58 - (termsList.length-1-gi)*13;
      layers.wires.push(<line key={`fh_${gi}`} x1={firstOut(terms, gy)} y1={gy} x2={collectX} y2={gy} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      if (Math.abs(gy-pinY)>0.5) layers.wires.push(<line key={`fv_${gi}`} x1={collectX} y1={gy} x2={collectX} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
      layers.wires.push(<line key={`fp_${gi}`} x1={collectX} y1={pinY} x2={X_FINAL-24} y2={pinY} stroke={C} strokeWidth={SW} strokeLinecap="square" />);
    });
    if (implMode === "nand") layers.gates.push(<AndGate key="final" x={X_FINAL} y={finalY} label="NAND" bubble />);
    else if (implMode === "nor") layers.gates.push(<OrGate key="final" x={X_FINAL} y={finalY} h={finalH} label="NOR" bubble />);
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
      branchDots.push(<circle key={`raw_dot_${v}`} cx={tapX} cy={y} r="3.3" fill={C}/>);
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

      branchDots.push(<circle key={`inv_dot_${v}`} cx={tapX} cy={y} r="3.3" fill={C}/>);
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
    branchDots.push(<circle key={`term_tap_dot_${gi}_${ti}`} cx={lx} cy={targetY} r="3.0" fill={C}/>);
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
  const [scrollY, setScrollY] = useState(0);
  const mainScrollRef = useRef(null);
  const snapTimerRef = useRef(null);

  const changeVarCount = useCallback((nextCount) => {
    const nextActualCount = activePreset === "mux" ? 3 : nextCount;
    setVarCount(nextActualCount);
    if (activePreset) {
      const built = buildPresetCells(activePreset, nextActualCount);
      setCells(built.cells);
    } else {
      setCells(Array(1 << nextActualCount).fill(0));
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

  const displayExpr = activeImpl === "standard" && detectXor && plans.xor ? `F = ${plans.xor.invert ? "(" + plans.xor.expr + ")'" : plans.xor.expr}` : activePlan.expr;
  const reco = useMemo(()=>recommendationSummary(plans, detectXor), [plans, detectXor]);
  const activeMetrics = estimateMetrics(activePlan, activeImpl);
  const breakdown = gateBreakdown(activePlan, activeImpl, plans.xor, detectXor);

  const mintermAt = useCallback((row, col) => cellToMinterm(row, col, cfg), [cfg]);
  const cycleCell = useCallback((m) => { setActivePreset(null); setCells(p => { const n=[...p]; n[m]=(n[m]+1)%3; return n; }); }, []);
  const fillAll = (val) => { setActivePreset(null); setCells(Array(cfg.total).fill(val)); };
  const fillRow = (row, val) => { setActivePreset(null); setCells(p => { const n=[...p]; cfg.colGray.forEach((_,col)=>{ n[cellToMinterm(row,col,cfg)] = val; }); return n; }); };
  const fillCol = (col, val) => { setActivePreset(null); setCells(p => { const n=[...p]; cfg.rowGray.forEach((_,row)=>{ n[cellToMinterm(row,col,cfg)] = val; }); return n; }); };
  const smartFillFromCell = (row, col) => {
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
    const presetVarCount = kind === "mux" ? 3 : count;
    const total = 1 << presetVarCount;
    const next = Array(total).fill(0);

    for (let m=0; m<total; m++) {
      const a = bitOf(m, 0, presetVarCount);
      const b = presetVarCount >= 2 ? bitOf(m, 1, presetVarCount) : 0;
      const s = presetVarCount >= 3 ? bitOf(m, 2, presetVarCount) : 0;

      if (kind === "xor") next[m] = a ^ b;
      else if (kind === "xnor") next[m] = (a ^ b) ? 0 : 1;
      else if (kind === "mux") next[m] = s ? b : a; // F = C'·A + C·B, C is selector S
    }
    return { cells: next, varCount: presetVarCount };
  };

  const applyPreset = (kind) => {
    const built = buildPresetCells(kind, varCount);
    if (built.varCount !== varCount) setVarCount(built.varCount);
    setCells(built.cells);
    setActivePreset(kind);
    showToast(`${kindLabel(kind)} preset applied`);
  };

  const cellColors = {};
  kmapPlan.groups.forEach((g,gi)=>g.forEach(m=>{ if(!cellColors[m]) cellColors[m]=[]; cellColors[m].push(GROUP_COLORS[gi%GROUP_COLORS.length]); }));
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
  const ResultCards = () => <div style={resultWrap()}>
    <div style={exprCard()}>
      <div style={cardLabel()}>EXPRESSION</div>
      <div style={{fontFamily:"'Courier New',monospace",fontSize:"0.9rem",fontWeight:900,lineHeight:1.45,color:"#1d4ed8",whiteSpace:"normal",wordBreak:"break-word"}}>{displayExpr}</div>
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
        <span style={resultKey()}>Preset</span>
        <span style={resultVal()}>{activePreset ? kindLabel(activePreset) : "—"}</span>
      </div>

      <div style={{fontSize:"0.68rem",fontWeight:850,color:"#475569",marginTop:6,lineHeight:1.35,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
        Gate {activeMetrics.gates} · Lit {activeMetrics.literals} · Depth {activeMetrics.depth} · Cost {implementationCost(activePlan, activeImpl)}
      </div>
    </div>
  </div>;

  const KmapTable = () => <table style={{borderCollapse:"separate",borderSpacing:3}}>
    <thead><tr>
      <td style={{width:76,height:32,textAlign:"right",paddingRight:6,fontSize:"0.68rem",color:"#64748b"}}><span style={{color:"#3b82f6"}}>{cfg.rowLabel}</span>↓ <span style={{color:"#16a34a"}}>{cfg.colLabel}</span>→</td>
      {cfg.colGray.map((cd,col)=><th key={cd} style={{width:cellSize+4,textAlign:"center",color:"#16a34a",fontSize:"0.7rem",fontWeight:800}}><button onClick={()=>{ if (editMode === "col") fillCol(col, (cells[mintermAt(0,col)] + 1) % 3); }} style={axisBtn(editMode==="col", "#16a34a")}>{cd}</button></th>)}
    </tr></thead>
    <tbody>{cfg.rowGray.map((ab,row)=><tr key={ab}>
      <th style={{textAlign:"center",color:"#3b82f6",fontSize:"0.7rem",fontWeight:800}}><button onClick={()=>{ if (editMode === "row") fillRow(row, (cells[mintermAt(row,0)] + 1) % 3); }} style={axisBtn(editMode==="row", "#3b82f6")}>{ab}</button></th>
      {cfg.colGray.map((_,col)=>{ const m=mintermAt(row,col), val=cells[m], c0=(cellColors[m]||[])[0]; return <td key={col} style={{padding:0}}><button onClick={()=>smartFillFromCell(row, col)} style={{width:cellSize,height:cellSize,border:c0?`2.5px solid ${c0}`:"1.5px solid #cbd5e1",borderRadius:6,background:val===1?(c0?c0+"22":"#dbeafe"):val===2?"#fef9c3":"#fff",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,transition:"all 0.12s"}}><span style={{fontSize:"1.3rem",fontWeight:900,lineHeight:1,color:val===1?(c0||"#3b82f6"):val===2?"#b45309":"#94a3b8"}}>{val===2?"X":val}</span><span style={{fontSize:"0.55rem",color:"#94a3b8",fontFamily:"monospace"}}>m{m}</span></button></td>; })}
    </tr>)}</tbody>
  </table>;

  const OptionsPanel = () => <div style={controlPanel()}>
    <div style={controlGrid()}>
      <CompactLine label="Vars"><PillGroup value={varCount} setValue={changeVarCount} items={[[2,"2"],[3,"3"],[4,"4"]]} /></CompactLine>
      <CompactLine label="Opt"><PillGroup value={optMode} setValue={setOptMode} items={[["sop","SOP"],["pos","POS"],["auto","Auto"]]} /></CompactLine>
      <div style={{gridColumn:"1 / -1",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,minWidth:0}}>
        <CompactLine label="Mode"><PillGroup value={editMode} setValue={setEditMode} items={[["cell","Cell"],["row","Row"],["col","Col"],["all","All"]]} /></CompactLine>
        <button onClick={()=>setAdvancedOpen(v=>!v)} style={moreBtn()}>{advancedOpen ? "Less ▲" : "More ▼"}</button>
      </div>
    </div>

    {advancedOpen && <div style={advancedGrid()}>
      <div style={{gridColumn:"1 / -1",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,minWidth:0}}>
        <CompactLine label="Impl"><PillGroup value={implMode} setValue={setImplMode} items={[["standard","Std"],["nand","NAND"],["nor","NOR"]]} /></CompactLine>
        <CompactLine label="XOR"><button onClick={()=>setDetectXor(v=>!v)} style={topBtn(detectXor)}>{detectXor?"ON":"OFF"}</button></CompactLine>
      </div>
      <CompactLine label="Preset"><div style={{display:"flex",gap:5,flexWrap:"wrap"}}><button onClick={()=>applyPreset("xor")} style={presetBtn(activePreset==="xor")}>XOR</button><button onClick={()=>applyPreset("xnor")} style={presetBtn(activePreset==="xnor")}>XNOR</button><button onClick={()=>applyPreset("mux")} style={presetBtn(activePreset==="mux")}>MUX</button></div></CompactLine>
    </div>}
  </div>;

  return <div style={{height:"100vh",display:"flex",flexDirection:"column",background:"#f1f5f9",fontFamily:"'Inter','Segoe UI',sans-serif",color:"#1e293b",overflow:"hidden"}}>
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
      {tab === "kmap" && <div style={{flex:"1 0 auto",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-start",padding:"8px 10px 12px",gap:8,minHeight:"calc(100vh - 132px)"}}>
        <KmapTable />
        <div style={{display:"flex",gap:8,flexWrap:"nowrap",justifyContent:"center",maxWidth:620}}>{kmapPlan.termsList.map((t,i)=><div key={i} style={{display:"inline-flex",alignItems:"center",gap:5,background:"#fff",border:`1.5px solid ${GROUP_COLORS[i%GROUP_COLORS.length]}`,borderRadius:6,padding:"4px 10px",fontSize:"0.7rem"}}><span style={{width:8,height:8,borderRadius:2,display:"inline-block",background:GROUP_COLORS[i%GROUP_COLORS.length]}}/><span style={{fontWeight:800,fontFamily:"monospace",color:GROUP_COLORS[i%GROUP_COLORS.length]}}>{kmapPlan.form==="SOP"?sopTermExpr(t):posTermExpr(t)}</span></div>)}</div>
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
    if (kind === "carry") return "Half Adder CARRY";
  if (kind === "mux") return "MUX";
  return kind;
}

function CompactLine({ label, children }) {
  return <div style={{display:"inline-flex",alignItems:"center",gap:5,minWidth:0,width:"fit-content"}}><span style={{fontSize:"0.62rem",fontWeight:950,color:"#475569",minWidth:32,textTransform:"uppercase",letterSpacing:"0.03em",flex:"0 0 auto"}}>{label}</span><div style={{minWidth:0,flex:"0 0 auto"}}>{children}</div></div>;
}

function PillGroup({ value, setValue, items, disabled=false }) {
  return <div style={{display:"flex",gap:3,background:disabled?"#e2e8f0":"#0f172a",borderRadius:9,padding:3,opacity:disabled?0.58:1,maxWidth:"100%"}}>{items.map(([id,lbl])=>{
    const active = value===id;
    return <button key={id} disabled={disabled} onClick={()=>!disabled && setValue(id)} style={{minHeight:31,padding:"6px 10px",borderRadius:7,border:"none",background:active?"#3b82f6":"transparent",color:active?"#fff":disabled?"#64748b":"#94a3b8",fontFamily:"inherit",fontSize:"0.7rem",fontWeight:900,cursor:disabled?"not-allowed":"pointer"}}>{lbl}</button>;
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
function moreBtn() {
  return {
    minHeight:32,
    padding:"5px 10px",
    border:"1.5px solid #cbd5e1",
    borderRadius:999,
    background:"#fff",
    color:"#334155",
    fontSize:"0.7rem",
    fontWeight:950,
    cursor:"pointer",
    whiteSpace:"nowrap"};
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
function resultWrap() { return {width:"100%",maxWidth:760,display:"grid",gridTemplateColumns:"minmax(0,1.35fr) minmax(220px,0.9fr)",gap:8}; }
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
function axisBtn(active, color) { return {minWidth:50,padding:"7px 8px",borderRadius:10,border:active?`2px solid ${color}`:"1.5px solid transparent",background:active?"#fff":"transparent",color,fontSize:"0.82rem",fontWeight:950,cursor:active?"pointer":"default"}; }
function btn(bg="#fff", color="#1e293b") { return {padding:"7px 14px",background:bg,color,border:"1.5px solid #cbd5e1",borderRadius:7,cursor:"pointer",fontSize:"0.76rem",fontFamily:"inherit",fontWeight:800}; }
function topBtn(active) { return {minHeight:31,padding:"6px 10px",borderRadius:9,border:"none",background:active?"#7c3aed":"#0f172a",color:active?"#fff":"#94a3b8",fontFamily:"inherit",fontSize:"0.7rem",fontWeight:900,cursor:"pointer"}; }
