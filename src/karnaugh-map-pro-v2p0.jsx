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
  // ANSI-style OR: no straight input wall. The left edge is a concave curve.
  const w = OR_W;
  const out = x + w;
  const bubbleR = 4.2;
  const back = x + w * 0.02;
  const nose = x + w;
  return <g>
    <path
      d={`
        M ${back} ${y-h}
        C ${x+w*0.34} ${y-h}, ${x+w*0.73} ${y-h*0.72}, ${nose} ${y}
        C ${x+w*0.73} ${y+h*0.72}, ${x+w*0.34} ${y+h}, ${back} ${y+h}
        C ${x+w*0.22} ${y+h*0.52}, ${x+w*0.22} ${y-h*0.52}, ${back} ${y-h}
        Z
      `}
      fill="#fff"
      stroke="#111"
      strokeWidth="1.9"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    {bubble && <circle cx={out+bubbleR} cy={y} r={bubbleR} fill="#fff" stroke="#111" strokeWidth="1.9" />}
    <text x={x+w*0.47} y={y+4} textAnchor="middle" fontSize="8.2" fontFamily="Arial,sans-serif" fontWeight="800">{label}</text>
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

function XorGate({ x, y, label="XOR" }) {
  // XOR = ANSI OR plus one separate concave input curve.
  return <g>
    <path
      d={`M${x-12},${y-26} C ${x+3},${y-10} ${x+3},${y+10} ${x-12},${y+26}`}
      fill="none"
      stroke="#111"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
    <OrGate x={x} y={y} h={26} label={label} />
  </g>;
}

function outX(kind, x, impl="standard") {
  if (kind === "or") return x + OR_W + (impl === "nor" ? 8.5 : 0);
  if (kind === "and") return x + AND_W*0.54 + AND_H + (impl === "nand" ? 8.5 : 0);
  if (kind === "xor") return x + OR_W;
  return x;
}
function fitViewBox(baseW, baseH, points, pad=90) {
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
    width: Math.max(520, maxX - minX),
    height: Math.max(280, maxY - minY),
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
  vars.forEach((v,i)=>{ railY[v]=PAD_T+24+i*ROW_GAP; invY[v]=railY[v]+INV_OFFSET; });
  const termY = termsList.map((_,i)=> PAD_T + vars.length*ROW_GAP + TOP_GAP + i*TERM_GAP);
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
    layers.labels.push(<text key={`tl_${gi}`} x={X_STAGE} y={gy-30} fontSize="10.5" fontFamily="'Courier New',monospace" fontWeight="800" fill={GROUP_COLORS[gi%GROUP_COLORS.length]}>{termText}</text>);
  });

  const orderedKeys = vars.flatMap(v=>[`${v}_RAW`,`${v}_INV`]).filter(k=>signalUses.has(k));
  const trunkX = {};
  orderedKeys.forEach((k,i)=>{ trunkX[k] = RAIL_END + 18 + i*24; });
  orderedKeys.forEach(key => {
    const uses = signalUses.get(key), x = trunkX[key], sy = srcY(key);
    const minY = Math.min(sy, ...uses.map(u=>u.pinY)), maxY = Math.max(sy, ...uses.map(u=>u.pinY));
    mark([RAIL_END,sy],[x,minY],[x,maxY],[X_STAGE, maxY]);
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

  mark([X_FINAL-55, finalY-finalH-12], [X_OUT+24, finalY+finalH+12]);
  if (hasFinal) {
    termsList.forEach((terms,gi)=>{
      const gy = termY[gi];
      const pinSpread = Math.min((termsList.length-1)*12, (finalH-5)*2);
      const pinY = finalY + (termsList.length===1 ? 0 : -pinSpread/2 + gi*pinSpread/(termsList.length-1));
      const collectX = X_FINAL - 58 - (termsList.length-1-gi)*9;
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

  return <svg viewBox={`0 0 ${W + 90} ${H + 70}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W + 90} height={H + 70} fill="#f8f9ff" />
    {layers.grid}{layers.bus}{layers.wires}{layers.gates}{layers.dots}{layers.labels}
    <text x={W+54} y={H+38} textAnchor="end" fontSize="10" fontFamily="Arial,sans-serif" fill="#64748b">{form} · {implMode.toUpperCase()}</text>
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
  return <svg viewBox={`0 0 ${W + 60} ${H + 40}`} style={{width:"100%",height:"100%",display:"block"}} preserveAspectRatio="xMidYMid meet">
    <rect width={W + 60} height={H + 40} fill="#f8f9ff" />{wires}{gates}{labels}
    <text x={W+24} y={H+10} textAnchor="end" fontSize="10" fontFamily="Arial,sans-serif" fill="#64748b">Detected {xorInfo.kind}</text>
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
  const [optMode, setOptMode] = useState("auto"); // sop | pos | auto
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
      <CompactLine label="Opt"><PillGroup value={optMode} setValue={setOptMode} items={[["auto","Auto"],["sop","SOP"],["pos","POS"]]} /></CompactLine>
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
