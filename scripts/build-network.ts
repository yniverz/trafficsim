// Converts the raw Overpass extract (data/raw/osm.json) into the compact simulation network
// (data/karlsruhe.json): road/tram/walk graph, buildings, POIs, transit stops and lines.
import fs from 'node:fs';
import {
  F_BIKE, F_BIKEINFRA, F_BRIDGE, F_CAR, F_ONEWAY, F_PEDZONE, F_ROUNDABOUT, F_TUNNEL, F_WALK,
  type BuildingData, type EdgeMode, type LineData, type NetEdgeData, type NetNodeData, type NetworkData, type PoiData, type StopData,
} from '../src/sim/types.ts';
import { Router } from '../src/sim/routing.ts';

const BBOX = { s: 48.993, w: 8.367, n: 49.018, e: 8.43 };
const ORIGIN = { lat: 49.0094, lon: 8.4037 }; // Marktplatz
const KX = Math.cos((ORIGIN.lat * Math.PI) / 180) * 111320;
const KY = 110574;
const proj = (lat: number, lon: number): [number, number] => [(lon - ORIGIN.lon) * KX, (lat - ORIGIN.lat) * KY];
const inBox = (lat: number, lon: number) => lat >= BBOX.s && lat <= BBOX.n && lon >= BBOX.w && lon <= BBOX.e;

console.log('reading osm.json ...');
const raw = JSON.parse(fs.readFileSync('data/raw/osm.json', 'utf8'));
interface ONode { lat: number; lon: number; tags?: Record<string, string> }
interface OWay { id: number; nodes: number[]; tags: Record<string, string> }
const onodes = new Map<number, ONode>();
const owayList: OWay[] = [];
const orels: any[] = [];
for (const e of raw.elements) {
  if (e.type === 'node') onodes.set(e.id, e);
  else if (e.type === 'way') owayList.push(e);
  else orels.push(e);
}
const owaysById = new Map<number, OWay>(owayList.map((w) => [w.id, w]));
console.log(onodes.size, 'nodes', owayList.length, 'ways', orels.length, 'rels');

// ---------------------------------------------------------------- classification helpers
const CLS: Record<string, number> = {
  motorway: 7, motorway_link: 7, trunk: 6, trunk_link: 6, primary: 5, primary_link: 5, secondary: 4, secondary_link: 4,
  tertiary: 3, tertiary_link: 3, unclassified: 2, residential: 1, living_street: 0, service: 0,
};
const DEF_SPEED: Record<string, number> = {
  motorway: 100, motorway_link: 60, trunk: 70, trunk_link: 50, primary: 50, primary_link: 40, secondary: 50, secondary_link: 40,
  tertiary: 50, tertiary_link: 40, unclassified: 50, residential: 30, living_street: 7, service: 20,
};
const DEF_LANES: Record<string, number> = { motorway: 2, trunk: 2, primary: 2, secondary: 1, tertiary: 1 };
const WALK_ONLY = new Set(['footway', 'path', 'steps', 'pedestrian']);

function parseSpeed(t: Record<string, string>, hw: string): number {
  const ms = t.maxspeed;
  let kmh = DEF_SPEED[hw] ?? 30;
  if (ms) {
    const m = ms.match(/^(\d+)/);
    if (m) kmh = +m[1];
    else if (/walk/.test(ms)) kmh = 7;
    else if (/urban/.test(ms)) kmh = 50;
  }
  return kmh / 3.6;
}

type RunKind = 'road' | 'tram' | 'walk';
interface Run {
  kind: RunKind;
  ids: number[];
  tags: Record<string, string>;
  gateStart: boolean;
  gateEnd: boolean;
  surface: boolean;
}

const nodeXY = new Map<number, [number, number]>();
const xyOf = (id: number): [number, number] => {
  let v = nodeXY.get(id);
  if (!v) {
    const n = onodes.get(id)!;
    v = proj(n.lat, n.lon);
    nodeXY.set(id, v);
  }
  return v;
};

// ---------------------------------------------------------------- collect runs inside bbox
const runs: Run[] = [];
for (const w of owayList) {
  const t = w.tags || {};
  let kind: RunKind | null = null;
  if (t.railway === 'tram') {
    if (['siding', 'yard', 'crossover', 'spur'].includes(t.service || '')) continue;
    kind = 'tram';
  } else if (t.highway) {
    const hw = t.highway;
    if (WALK_ONLY.has(hw) || hw === 'cycleway') kind = 'walk';
    else if (hw in CLS) {
      if (hw === 'service' && ['driveway', 'parking_aisle', 'drive-through', 'emergency_access'].includes(t.service || '')) continue;
      if (t.access === 'private' || t.access === 'no') continue;
      kind = 'road';
    }
    if (hw === 'footway' && t.footway === 'sidewalk') continue; // sidewalks are implied along roads
    if (t.indoor) continue;
  }
  if (!kind) continue;
  let cur: number[] = [];
  const flush = (gateEnd: boolean) => {
    if (cur.length >= 2) runs.push({ kind: kind!, ids: cur, tags: t, gateStart: false, gateEnd, surface: t.tunnel !== 'yes' && t.tunnel !== 'building_passage' && !t.bridge });
    cur = [];
  };
  let first = true;
  const startRunCount = runs.length;
  for (let i = 0; i < w.nodes.length; i++) {
    const n = onodes.get(w.nodes[i]);
    if (!n) continue;
    if (inBox(n.lat, n.lon)) {
      cur.push(w.nodes[i]);
      first = false;
    } else {
      if (cur.length) flush(true);
    }
  }
  void first;
  if (cur.length) flush(false);
  // mark gateStart for runs whose first node is not the way's first node
  for (let r = startRunCount; r < runs.length; r++) {
    const run = runs[r];
    if (run.ids[0] !== w.nodes[0]) run.gateStart = true;
  }
}
console.log('runs', runs.length);

// ---------------------------------------------------------------- tram x road geometric crossings
function segInter(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number, number] | null {
  const rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sY - (cy - ay) * sX) / den;
  const u = ((cx - ax) * rY - (cy - ay) * rX) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return [t, u, 0];
}
{
  const CELL = 60;
  const grid = new Map<string, [number, number][]>();
  runs.forEach((r, ri) => {
    if (r.kind !== 'road' || !r.surface) return;
    for (let i = 0; i + 1 < r.ids.length; i++) {
      const [x1, y1] = xyOf(r.ids[i]);
      const [x2, y2] = xyOf(r.ids[i + 1]);
      for (let cx = Math.floor(Math.min(x1, x2) / CELL); cx <= Math.floor(Math.max(x1, x2) / CELL); cx++)
        for (let cy = Math.floor(Math.min(y1, y2) / CELL); cy <= Math.floor(Math.max(y1, y2) / CELL); cy++) {
          const k = cx + ',' + cy;
          let a = grid.get(k);
          if (!a) grid.set(k, (a = []));
          a.push([ri, i]);
        }
    }
  });
  const ins = new Map<number, { seg: number; t: number; id: number }[]>();
  let synth = -1;
  let count = 0;
  const addIns = (ri: number, seg: number, t: number, id: number) => {
    let a = ins.get(ri);
    if (!a) ins.set(ri, (a = []));
    a.push({ seg, t, id });
  };
  runs.forEach((tr, ti) => {
    if (tr.kind !== 'tram' || !tr.surface) return;
    for (let i = 0; i + 1 < tr.ids.length; i++) {
      const [ax, ay] = xyOf(tr.ids[i]);
      const [bx, by] = xyOf(tr.ids[i + 1]);
      const seen = new Set<string>();
      for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++)
        for (let cy = Math.floor(Math.min(ay, by) / CELL); cy <= Math.floor(Math.max(ay, by) / CELL); cy++) {
          for (const [ri, j] of grid.get(cx + ',' + cy) || []) {
            const key = ri + ':' + j;
            if (seen.has(key)) continue;
            seen.add(key);
            const rr = runs[ri];
            const [cx2, cy2] = xyOf(rr.ids[j]);
            const [dx, dy] = xyOf(rr.ids[j + 1]);
            const hit = segInter(ax, ay, bx, by, cx2, cy2, dx, dy);
            if (!hit) continue;
            // skip when already connected through shared nodes nearby
            const trNear = [tr.ids[i - 1], tr.ids[i], tr.ids[i + 1], tr.ids[i + 2]];
            const rdNear = [rr.ids[j - 1], rr.ids[j], rr.ids[j + 1], rr.ids[j + 2]];
            if (trNear.some((id) => id !== undefined && rdNear.includes(id))) continue;
            const id = synth--;
            const px = ax + (bx - ax) * hit[0];
            const py = ay + (by - ay) * hit[0];
            nodeXY.set(id, [px, py]);
            addIns(ti, i, hit[0], id);
            addIns(ri, j, hit[1], id);
            count++;
          }
        }
    }
  });
  for (const [ri, list] of ins) {
    const r = runs[ri];
    list.sort((a, b) => a.seg - b.seg || a.t - b.t);
    const out: number[] = [];
    let k = 0;
    for (let i = 0; i < r.ids.length; i++) {
      out.push(r.ids[i]);
      while (k < list.length && list[k].seg === i) out.push(list[k++].id);
    }
    r.ids = out;
  }
  syntheticSet = new Set([...ins.values()].flat().map((x) => x.id));
  console.log('tram/road crossings inserted:', count);
}
// eslint-disable-next-line no-var
var syntheticSet: Set<number>;

// ---------------------------------------------------------------- junction detection
const use = new Map<number, number>();
for (const r of runs) {
  r.ids.forEach((id, i) => use.set(id, (use.get(id) || 0) + (i === 0 || i === r.ids.length - 1 ? 2 : 1)));
}
const special = (id: number) => {
  if (syntheticSet.has(id)) return true;
  const n = onodes.get(id);
  const t = n?.tags;
  if (!t) return false;
  return t.highway === 'traffic_signals' || t.highway === 'crossing' || t.railway === 'crossing' || t.railway === 'level_crossing';
};
const isJunction = (id: number) => (use.get(id) || 0) >= 3 || special(id);

// ---------------------------------------------------------------- build edges
const names: string[] = [];
const nameIdx = new Map<string, number>();
const nameOf = (s?: string) => {
  if (!s) return -1;
  let i = nameIdx.get(s);
  if (i === undefined) {
    i = names.length;
    names.push(s);
    nameIdx.set(s, i);
  }
  return i;
};

interface RawEdge {
  from: number; // osm/synth id
  to: number;
  mode: EdgeMode;
  pts: number[];
  speed: number;
  lanes: number;
  cls: number;
  flags: number;
  name: number;
  pairKey?: number; // links reverse twins
}
const rawEdges: RawEdge[] = [];
const gateNodes = new Set<number>();

function splitRun(r: Run): number[][] {
  const parts: number[][] = [];
  let cur = [0];
  for (let i = 1; i < r.ids.length; i++) {
    cur.push(i);
    if (i === r.ids.length - 1 || isJunction(r.ids[i])) {
      parts.push(cur);
      cur = [i];
    }
  }
  return parts;
}

let twin = 1;
for (const r of runs) {
  const t = r.tags;
  const hw = t.highway || '';
  if (r.gateStart) gateNodes.add(r.ids[0]);
  if (r.gateEnd) gateNodes.add(r.ids[r.ids.length - 1]);
  const parts = splitRun(r);
  for (const p of parts) {
    const ids = p.map((i) => r.ids[i]);
    if (ids[0] === ids[ids.length - 1] && ids.length < 4) continue;
    const pts: number[] = [];
    for (const id of ids) {
      const [x, y] = xyOf(id);
      pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
    }
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    if (len < 1) continue;
    const rev = (a: number[]) => {
      const o: number[] = [];
      for (let i = a.length - 2; i >= 0; i -= 2) o.push(a[i], a[i + 1]);
      return o;
    };
    let flagsBase = 0;
    if (t.tunnel === 'yes' || t.tunnel === 'building_passage') flagsBase |= F_TUNNEL;
    if (t.bridge && t.bridge !== 'no') flagsBase |= F_BRIDGE;
    const name = nameOf(t.name);
    if (r.kind === 'walk') {
      if (hw === 'cycleway') {
        const key = twin++;
        const f = flagsBase | F_BIKE | F_WALK | F_BIKEINFRA;
        rawEdges.push({ from: ids[0], to: ids[ids.length - 1], mode: 'road', pts, speed: 6, lanes: 0, cls: 0, flags: f, name, pairKey: key });
        rawEdges.push({ from: ids[ids.length - 1], to: ids[0], mode: 'road', pts: rev(pts), speed: 6, lanes: 0, cls: 0, flags: f, name, pairKey: key });
      } else {
        const f = flagsBase | F_WALK | (hw === 'pedestrian' ? F_PEDZONE : 0);
        rawEdges.push({ from: ids[0], to: ids[ids.length - 1], mode: 'walk', pts, speed: 1.4, lanes: 0, cls: 0, flags: f, name });
      }
    } else if (r.kind === 'tram') {
      const oneway = t.oneway === 'yes';
      const key = twin++;
      const sp = Math.min(t.maxspeed ? parseSpeed(t, 'tertiary') : 50 / 3.6, 60 / 3.6);
      rawEdges.push({ from: ids[0], to: ids[ids.length - 1], mode: 'tram', pts, speed: sp, lanes: 1, cls: 0, flags: flagsBase | (oneway ? F_ONEWAY : 0), name, pairKey: oneway ? undefined : key });
      if (!oneway) rawEdges.push({ from: ids[ids.length - 1], to: ids[0], mode: 'tram', pts: rev(pts), speed: sp, lanes: 1, cls: 0, flags: flagsBase, name, pairKey: key });
    } else {
      const cls = CLS[hw];
      let oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout' || hw === 'motorway';
      let reverse = t.oneway === '-1' || t.oneway === 'reverse';
      if (reverse) oneway = true;
      let lanesTot = parseInt(t.lanes || '');
      let lanes: number;
      if (!isNaN(lanesTot)) lanes = oneway ? lanesTot : Math.max(1, Math.ceil(lanesTot / 2));
      else lanes = DEF_LANES[hw.replace('_link', '')] ?? 1;
      if (hw.endsWith('_link')) lanes = 1;
      lanes = Math.max(1, Math.min(4, lanes));
      const speed = parseSpeed(t, hw);
      let f = flagsBase | F_CAR | F_WALK | F_BIKE;
      if (hw.startsWith('motorway') || hw.startsWith('trunk')) f &= ~(F_BIKE | F_WALK);
      if (t.junction === 'roundabout') f |= F_ROUNDABOUT;
      if (oneway) f |= F_ONEWAY;
      if (/lane|track/.test((t.cycleway || '') + (t['cycleway:right'] || '') + (t['cycleway:left'] || '') + (t['cycleway:both'] || ''))) f |= F_BIKEINFRA;
      if (t.motor_vehicle === 'no' || t.vehicle === 'no') f &= ~F_CAR;
      if (!(f & F_CAR)) continue;
      const key = twin++;
      if (oneway) {
        const a = reverse ? rev(pts) : pts;
        const from = reverse ? ids[ids.length - 1] : ids[0];
        const to = reverse ? ids[0] : ids[ids.length - 1];
        rawEdges.push({ from, to, mode: 'road', pts: a, speed, lanes, cls, flags: f, name });
      } else {
        rawEdges.push({ from: ids[0], to: ids[ids.length - 1], mode: 'road', pts, speed, lanes, cls, flags: f, name, pairKey: key });
        rawEdges.push({ from: ids[ids.length - 1], to: ids[0], mode: 'road', pts: rev(pts), speed, lanes, cls, flags: f, name, pairKey: key });
      }
    }
  }
}
console.log('raw edges', rawEdges.length);

// ---------------------------------------------------------------- connectivity filtering
function tarjanKeep(edgeIdx: number[], minSize: number): Set<number> {
  const adj = new Map<number, number[]>();
  for (const i of edgeIdx) {
    const e = rawEdges[i];
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
  }
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const comp = new Map<number, number>();
  const sizes: number[] = [];
  let idx = 0;
  for (const root of adj.keys()) {
    if (index.has(root)) continue;
    const work: [number, number][] = [[root, 0]];
    index.set(root, idx); low.set(root, idx); idx++;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      const nb = adj.get(v)!;
      if (i < nb.length) {
        top[1]++;
        const w = nb[i];
        if (!index.has(w)) {
          index.set(w, idx); low.set(w, idx); idx++;
          stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low.set(p, Math.min(low.get(p)!, low.get(v)!));
        }
        if (low.get(v) === index.get(v)) {
          const c = sizes.length;
          let n = 0;
          let w: number;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, c);
            n++;
          } while (w !== v);
          sizes.push(n);
        }
      }
    }
  }
  const keepComp = new Set<number>();
  let biggest = 0;
  sizes.forEach((s, i) => { if (s > sizes[biggest]) biggest = i; });
  sizes.forEach((s, i) => { if (s >= minSize) keepComp.add(i); });
  if (minSize === Infinity) { keepComp.clear(); keepComp.add(biggest); }
  const keepNodes = new Set<number>();
  for (const [n, c] of comp) if (keepComp.has(c)) keepNodes.add(n);
  return keepNodes;
}

const carIdx: number[] = [], tramIdx: number[] = [];
rawEdges.forEach((e, i) => {
  if (e.mode === 'road' && e.lanes > 0) carIdx.push(i);
  else if (e.mode === 'tram') tramIdx.push(i);
});
const keepCar = tarjanKeep(carIdx, Infinity);
const keepTram = tarjanKeep(tramIdx, 8);
let alive = rawEdges.filter((e) => {
  if (e.mode === 'road' && e.lanes > 0) return keepCar.has(e.from) && keepCar.has(e.to);
  if (e.mode === 'tram') return keepTram.has(e.from) && keepTram.has(e.to);
  return true;
});
// walk/bike connectivity: undirected largest component over every walkable edge
{
  const par = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (par.get(r) !== r) r = par.get(r)!;
    while (par.get(a) !== r) { const n = par.get(a)!; par.set(a, r); a = n; }
    return r;
  };
  for (const e of alive) {
    if (!(e.mode === 'walk' || e.flags & F_WALK)) continue;
    if (!par.has(e.from)) par.set(e.from, e.from);
    if (!par.has(e.to)) par.set(e.to, e.to);
    par.set(find(e.from), find(e.to));
  }
  const sizes = new Map<number, number>();
  for (const n of par.keys()) sizes.set(find(n), (sizes.get(find(n)) || 0) + 1);
  let best = -1, bs = 0;
  for (const [k, s] of sizes) if (s > bs) { bs = s; best = k; }
  alive = alive.filter((e) => {
    if (e.mode === 'walk' || (e.mode === 'road' && e.lanes === 0)) return par.has(e.from) && find(e.from) === best;
    return true;
  });
}
console.log('edges kept', alive.length);

// ---------------------------------------------------------------- join close junctions
// OSM often models one real intersection as several nodes a few metres apart (dual carriageways,
// separate signal heads). Contract short road edges into a single junction so signals and
// right-of-way behave like one intersection.
const clusterInfo = new Map<number, { signal: number; cross: number; gate: number }>();
{
  const SHORT = process.env.JOIN === '0' ? 0 : 22;
  const MAXEXT = 45;
  const elen2 = (e: RawEdge) => { let l = 0; for (let i = 2; i < e.pts.length; i += 2) l += Math.hypot(e.pts[i] - e.pts[i - 2], e.pts[i + 1] - e.pts[i - 1]); return l; };
  const par = new Map<number, number>();
  const find = (a: number): number => { let r = a; while ((par.get(r) ?? r) !== r) r = par.get(r)!; let c = a; while ((par.get(c) ?? c) !== r) { const n = par.get(c)!; par.set(c, r); c = n; } return r; };
  const members = new Map<number, number[]>();
  const memOf = (r: number) => members.get(r) ?? [r];
  const isRoundabout = (e: RawEdge) => (e.flags & F_ROUNDABOUT) !== 0;
  const degree = new Map<number, number>();
  for (const e of alive) { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); }
  const junctionish = (id: number) => (degree.get(id) || 0) >= 3 * 1 || special(id);
  const cand = alive.filter((e) => e.mode === 'road' && e.lanes > 0 && !isRoundabout(e) && elen2(e) < SHORT && junctionish(e.from) && junctionish(e.to) && !gateNodes.has(e.from) && !gateNodes.has(e.to));
  cand.sort((a, b) => elen2(a) - elen2(b));
  for (const e of cand) {
    const ra = find(e.from), rb = find(e.to);
    if (ra === rb) continue;
    const m = [...memOf(ra), ...memOf(rb)];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of m) { const [x, y] = xyOf(id); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (Math.hypot(x1 - x0, y1 - y0) > MAXEXT) continue;
    par.set(rb, ra);
    members.set(ra, m);
    members.delete(rb);
  }
  let synthId = -1000000;
  const rep = new Map<number, number>();
  for (const [root, m] of members) {
    if (m.length < 2) continue;
    const id = synthId--;
    let sx = 0, sy = 0, sig = 0, cross = 0, gate = 0;
    for (const n of m) {
      const [x, y] = xyOf(n);
      sx += x; sy += y;
      const t = onodes.get(n)?.tags || {};
      if (t.highway === 'traffic_signals') sig = 1;
      if (t.highway === 'crossing' || t.railway === 'crossing') cross = Math.max(cross, t.crossing === 'traffic_signals' ? 3 : t.crossing === 'zebra' || t.crossing_ref === 'zebra' ? 2 : 1);
      if (gateNodes.has(n)) gate = 1;
      rep.set(n, id);
    }
    nodeXY.set(id, [sx / m.length, sy / m.length]);
    clusterInfo.set(id, { signal: sig, cross, gate });
  }
  const out: RawEdge[] = [];
  let dropped = 0;
  for (const e of alive) {
    const f = rep.get(e.from) ?? e.from, t = rep.get(e.to) ?? e.to;
    if (f === t && (rep.has(e.from) || rep.has(e.to))) { dropped++; continue; }
    if (f !== e.from) { const [x, y] = xyOf(f); e.pts = [Math.round(x * 10) / 10, Math.round(y * 10) / 10, ...e.pts.slice(2)]; e.from = f; }
    if (t !== e.to) { const [x, y] = xyOf(t); e.pts = [...e.pts.slice(0, -2), Math.round(x * 10) / 10, Math.round(y * 10) / 10]; e.to = t; }
    out.push(e);
  }
  alive = out;
  console.log('junction clusters', [...members.values()].filter((m) => m.length > 1).length, 'edges contracted', dropped);
}

// ---------------------------------------------------------------- finalise nodes and edges
const nodeIndex = new Map<number, number>();
const nodes: NetNodeData[] = [];
const nodeOf = (id: number) => {
  let i = nodeIndex.get(id);
  if (i === undefined) {
    const [x, y] = xyOf(id);
    const ci = clusterInfo.get(id);
    const t = onodes.get(id)?.tags || {};
    let cross = 0;
    if (t.highway === 'crossing' || t.railway === 'crossing') {
      cross = 1;
      if (t.crossing === 'zebra' || t.crossing_ref === 'zebra' || t.crossing === 'marked') cross = 2;
      if (t.crossing === 'traffic_signals') cross = 3;
    }
    if (ci) { cross = ci.cross; }
    i = nodes.length;
    nodes.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, signal: ci ? ci.signal : t.highway === 'traffic_signals' ? 1 : 0, cross, gate: ci ? ci.gate : gateNodes.has(id) ? 1 : 0 });
    nodeIndex.set(id, i);
  }
  return i;
};
const edges: NetEdgeData[] = [];
const twinMap = new Map<number, number>();
for (const e of alive) {
  const id = edges.length;
  let rev = -1;
  if (e.pairKey !== undefined) {
    const o = twinMap.get(e.pairKey);
    if (o !== undefined) {
      rev = o;
      edges[o].rev = id;
    } else twinMap.set(e.pairKey, id);
  }
  let len = 0;
  for (let i = 2; i < e.pts.length; i += 2) len += Math.hypot(e.pts[i] - e.pts[i - 2], e.pts[i + 1] - e.pts[i - 1]);
  edges.push({ from: nodeOf(e.from), to: nodeOf(e.to), mode: e.mode, pts: e.pts, speed: e.speed, lanes: e.lanes, cls: e.cls, flags: e.flags, rev, name: e.name });
  void len;
}
// signals: a crossing with signals but a node with two road arms stays signal; propagate zebra info
console.log('nodes', nodes.length, 'signals', nodes.filter((n) => n.signal).length, 'gates', nodes.filter((n) => n.gate).length);

// graph views for routing --------------------------------------------------
const elen = edges.map((e) => {
  let l = 0;
  for (let i = 2; i < e.pts.length; i += 2) l += Math.hypot(e.pts[i] - e.pts[i - 2], e.pts[i + 1] - e.pts[i - 1]);
  return l;
});
function makeRouter(mode: EdgeMode, vmax: number) {
  const out: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => { if (e.mode === mode && (mode !== 'road' || e.lanes > 0)) out[e.from].push(i); });
  return new Router({
    nodeCount: nodes.length,
    nodeX: nodes.map((n) => n.x),
    nodeY: nodes.map((n) => n.y),
    edgeFrom: edges.map((e) => e.from),
    edgeTo: edges.map((e) => e.to),
    out,
  }, vmax);
}
const tramRouter = makeRouter('tram', 60 / 3.6);
const roadRouter = makeRouter('road', 100 / 3.6);

// ---------------------------------------------------------------- buildings & POIs
const buildings: BuildingData[] = [];
const RES = new Set(['apartments', 'residential', 'house', 'detached', 'terrace', 'semidetached_house', 'dormitory', 'bungalow', 'townhouse']);
const WORK = new Set(['commercial', 'office', 'industrial', 'warehouse', 'public', 'civic', 'government', 'service', 'manufacture', 'hotel']);
const RETAIL = new Set(['retail', 'supermarket', 'kiosk']);
const EDU = new Set(['school', 'university', 'college', 'kindergarten']);
const HEALTH = new Set(['hospital', 'clinic']);
for (const w of owayList) {
  const t = w.tags;
  if (!t || !t.building) continue;
  const pts: number[] = [];
  let anyIn = false;
  for (const id of w.nodes) {
    const n = onodes.get(id);
    if (!n) continue;
    if (inBox(n.lat, n.lon)) anyIn = true;
    const [x, y] = xyOf(id);
    pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  }
  if (!anyIn || pts.length < 8) continue;
  if (['roof', 'garage', 'garages', 'shed', 'carport', 'hut', 'cabin', 'greenhouse', 'service', 'ruins'].includes(t.building) && t.building !== 'service') continue;
  let h = parseFloat(t.height || '');
  if (isNaN(h)) {
    const lv = parseFloat(t['building:levels'] || '');
    h = !isNaN(lv) ? lv * 3.2 + 1.5 : 9 + (hash(w.id) % 6);
  }
  h = Math.max(3, Math.min(120, h));
  let kind = 0;
  const b = t.building;
  if (RES.has(b)) kind = 1;
  else if (WORK.has(b)) kind = 2;
  else if (RETAIL.has(b)) kind = 3;
  else if (EDU.has(b)) kind = 4;
  else if (HEALTH.has(b)) kind = 5;
  buildings.push({ pts, h: Math.round(h * 10) / 10, kind });
}
function hash(n: number) {
  n = ((n >>> 16) ^ n) * 0x45d9f3b;
  n = ((n >>> 16) ^ n) * 0x45d9f3b;
  return (n >>> 16) >>> 0;
}
const pois: PoiData[] = [];
for (const [id, n] of onodes) {
  const t = n.tags;
  if (!t || !inBox(n.lat, n.lon)) continue;
  let kind = 0;
  if (t.shop) kind = 1;
  else if (['restaurant', 'cafe'].includes(t.amenity)) kind = 2;
  else if (['cinema', 'theatre'].includes(t.amenity)) kind = 3;
  else if (['school', 'university', 'college'].includes(t.amenity)) kind = 4;
  else if (t.amenity === 'hospital') kind = 5;
  else if (t.amenity === 'marketplace') kind = 6;
  if (!kind) continue;
  const [x, y] = xyOf(id);
  pois.push({ x: Math.round(x), y: Math.round(y), kind });
}
console.log('buildings', buildings.length, 'pois', pois.length);

// ---------------------------------------------------------------- nearest-edge helpers
const ebox = edges.map((e) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < e.pts.length; i += 2) { x0 = Math.min(x0, e.pts[i]); x1 = Math.max(x1, e.pts[i]); y0 = Math.min(y0, e.pts[i + 1]); y1 = Math.max(y1, e.pts[i + 1]); }
  return [x0, y0, x1, y1];
});
function projectOn(i: number, x: number, y: number, maxD: number): { edge: number; s: number; d: number } | null {
  const bx = ebox[i];
  if (x < bx[0] - maxD || x > bx[2] + maxD || y < bx[1] - maxD || y > bx[3] + maxD) return null;
  const p = edges[i].pts;
  let acc = 0;
  let best: { edge: number; s: number; d: number } | null = null;
  for (let k = 2; k < p.length; k += 2) {
    const ax = p[k - 2], ay = p[k - 1];
    const dx = p[k] - ax, dy = p[k + 1] - ay;
    const l2 = dx * dx + dy * dy;
    const sl = Math.sqrt(l2);
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < maxD && (!best || d < best.d)) best = { edge: i, s: acc + sl * t, d };
    acc += sl;
  }
  return best;
}
function nearest(x: number, y: number, pred: (i: number) => boolean, maxD: number): { edge: number; s: number; d: number } | null {
  let best: { edge: number; s: number; d: number } | null = null;
  for (let i = 0; i < edges.length; i++) {
    if (!pred(i)) continue;
    const r = projectOn(i, x, y, maxD);
    if (r && (!best || r.d < best.d)) best = r;
  }
  return best;
}

// ---------------------------------------------------------------- transit
const stops: StopData[] = [];
const lines: LineData[] = [];
const stopKey = new Map<string, number>();
const walkPred = (i: number) => !!(edges[i].mode === 'walk' || (edges[i].flags & F_WALK));

function candidates(x: number, y: number, mode: 'tram' | 'bus', maxD: number): { edge: number; s: number; d: number }[] {
  const res: { edge: number; s: number; d: number }[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (mode === 'tram' ? e.mode !== 'tram' : !(e.mode === 'road' && e.lanes > 0 && (e.flags & F_CAR) && e.cls >= 1 && e.cls <= 5)) continue;
    const r = projectOn(i, x, y, maxD);
    if (r) res.push(r);
  }
  res.sort((a, b) => a.d - b.d);
  return res;
}

const palette = ['#e2001a', '#009640', '#ffd500', '#0072bc', '#f39200', '#8e44ad', '#16a085', '#c0392b', '#2c3e50', '#d35400'];
const lineColors: Record<string, string> = { '1': '#ed1c24', '2': '#0099d8', '3': '#8c5a2a', '4': '#00a651', '5': '#00b5ad', '6': '#f59ad0', S1: '#00a76d', S11: '#00a76d', S2: '#a9338b', S4: '#9d2a77', S5: '#f7a600', S51: '#f7a600', S52: '#f7a600', S8: '#3b5ba5', NL1: '#6d6e71' };

function headwaysFor(mode: 'tram' | 'bus', ref: string): number[] {
  // seconds: peak, daytime, evening, early/late
  if (mode === 'tram') {
    if (/^S/.test(ref)) return [1200, 1200, 1800, 1800];
    if (/^NL/.test(ref)) return [3600, 3600, 3600, 3600];
    return [450, 600, 900, 1200];
  }
  return [600, 900, 1200, 1800];
}

let lineId = 0;
const seenSig = new Set<string>();
for (const rel of orels) {
  const t = rel.tags || {};
  if (t.type !== 'route' || (t.route !== 'tram' && t.route !== 'bus')) continue;
  const mode = t.route as 'tram' | 'bus';
  const ref = t.ref || '';
  if (/flix|KIT|KSC|Messe|shuttle/i.test((t.name || '') + (t.operator || '') + ref)) continue;
  if (mode === 'tram' && !/^(\d|S\d|NL\d)/.test(ref)) continue; // event / special services
  if (/^N|^8\d\d$/.test(ref) && mode === 'bus') continue; // night buses
  const stopMembers: { x: number; y: number; name: string }[] = [];
  for (const m of rel.members) {
    if (m.type !== 'node' || !/^stop/.test(m.role)) continue;
    const n = onodes.get(m.ref);
    if (!n) continue;
    const [x, y] = proj(n.lat, n.lon);
    stopMembers.push({ x, y, name: n.tags?.name || '' });
  }
  // keep stops inside bbox
  const inside = stopMembers.filter((s) => {
    return s.x > (BBOX.w - ORIGIN.lon) * KX + 20 && s.x < (BBOX.e - ORIGIN.lon) * KX - 20 && s.y > (BBOX.s - ORIGIN.lat) * KY + 20 && s.y < (BBOX.n - ORIGIN.lat) * KY - 20;
  });
  if (inside.length < 2) continue;
  // greedy leg-by-leg routing
  const router = mode === 'tram' ? tramRouter : roadRouter;
  const cost = (e: number) => elen[e] / Math.max(2, edges[e].speed) + (mode === 'bus' ? (edges[e].cls <= 1 ? 8 : 0) : 0);
  let routeEdges: number[] = [];
  const stopRefs: { routeIdx: number; s: number; sx: number; sy: number; name: string }[] = [];
  let prevEdge = -1;
  let ok = true;
  let first = true;
  for (let si = 0; si < inside.length; si++) {
    const st = inside[si];
    const cands = candidates(st.x, st.y, mode, mode === 'tram' ? 35 : 30);
    if (!cands.length) { if (first) continue; else continue; }
    if (first) {
      // choose candidate for the first stop that minimises path to the next stop; try all (few)
      const nextSt = inside[si + 1];
      if (!nextSt) break;
      const nextC = candidates(nextSt.x, nextSt.y, mode, mode === 'tram' ? 35 : 30);
      let bestPath: number[] | null = null, bestStart = -1, bestCost = Infinity;
      for (const c of cands.slice(0, 6)) {
        const targets = new Set(nextC.map((n) => edges[n.edge].from));
        if (!targets.size) continue;
        const r = router.routeToAny(edges[c.edge].to, targets, cost);
        if (!r) continue;
        const cc = r.edges.reduce((a, e) => a + cost(e), 0);
        if (cc < bestCost) { bestCost = cc; bestPath = r.edges; bestStart = c.edge; }
      }
      if (bestStart < 0 || !bestPath) continue;
      const c0 = cands.find((c) => c.edge === bestStart)!;
      routeEdges = [bestStart];
      stopRefs.push({ routeIdx: 0, s: c0.s, sx: st.x, sy: st.y, name: st.name });
      // find target edge for next stop: next edge after path
      const last = bestPath.length ? edges[bestPath[bestPath.length - 1]].to : edges[bestStart].to;
      const tgt = nextC.find((n) => edges[n.edge].from === last)!;
      routeEdges.push(...bestPath, tgt.edge);
      stopRefs.push({ routeIdx: routeEdges.length - 1, s: tgt.s, sx: nextSt.x, sy: nextSt.y, name: nextSt.name });
      prevEdge = tgt.edge;
      first = false;
      si++; // consumed next stop
      continue;
    }
    const targets = new Set(cands.map((n) => edges[n.edge].from));
    const startNode = edges[prevEdge].to;
    // same-edge stop ahead?
    const same = cands.find((c) => c.edge === prevEdge && c.s > stopRefs[stopRefs.length - 1].s + 10);
    if (same) {
      stopRefs.push({ routeIdx: routeEdges.length - 1, s: same.s, sx: st.x, sy: st.y, name: st.name });
      continue;
    }
    const r = router.routeToAny(startNode, targets, cost);
    if (!r) { ok = si > 1 ? true : false; if (!ok) break; continue; }
    const tgt = cands.find((n) => edges[n.edge].from === r.node)!;
    routeEdges.push(...r.edges, tgt.edge);
    stopRefs.push({ routeIdx: routeEdges.length - 1, s: tgt.s, sx: st.x, sy: st.y, name: st.name });
    prevEdge = tgt.edge;
  }
  if (!ok || stopRefs.length < 2) continue;
  const sig = mode + ref + stopRefs.map((s) => s.name).join('|');
  if (seenSig.has(sig)) continue;
  seenSig.add(sig);
  // register stops
  const lineStops: { routeIdx: number; stop: number }[] = [];
  for (const sr of stopRefs) {
    const edge = routeEdges[sr.routeIdx];
    const elen_ = elen[edge];
    const s = Math.max(Math.min(elen_ * 0.6, 12), Math.min(sr.s, elen_ - 9));
    const key = mode + ':' + edge + ':' + Math.round(s / 25);
    let sid = stopKey.get(key);
    if (sid === undefined) {
      const wp = nearest(sr.sx, sr.sy, walkPred, 120);
      if (!wp) continue;
      sid = stops.length;
      stopKey.set(key, sid);
      stops.push({ id: sid, name: sr.name || 'Haltestelle', mode, edge, s: Math.round(s * 10) / 10, x: sr.sx, y: sr.sy, walkEdge: wp.edge, walkS: wp.s });
    }
    lineStops.push({ routeIdx: sr.routeIdx, stop: sid });
  }
  if (lineStops.length < 2) continue;
  lines.push({
    id: lineId++, ref, name: t.name || ref, mode, route: routeEdges, stops: lineStops, headway: headwaysFor(mode, ref),
    color: lineColors[ref] || (mode === 'tram' ? '#e2001a' : palette[lineId % palette.length]),
  });
}
console.log('stops', stops.length, 'lines', lines.length, `(${lines.filter((l) => l.mode === 'tram').length} tram)`);

// ---------------------------------------------------------------- write
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
const data: NetworkData = { origin: ORIGIN, bounds: { minX, minY, maxX, maxY }, names, nodes, edges, buildings, pois, stops, lines };
fs.writeFileSync('public/data/karlsruhe.json', JSON.stringify(data));
const sz = fs.statSync('public/data/karlsruhe.json').size;
console.log('wrote data/karlsruhe.json', (sz / 1e6).toFixed(2), 'MB');
const modes = { road: 0, tram: 0, walk: 0 } as Record<string, number>;
edges.forEach((e) => modes[e.mode]++);
console.log(modes);
