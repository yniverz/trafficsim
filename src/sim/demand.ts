// Synthetic population: every agent has a home, a role and a daily plan of trips with
// departure times and a mode. Locations come from OSM buildings and POIs.
import { F_BIKE, F_CAR, F_WALK } from './types';
import { M_ROAD, M_WALK, type Network } from './network';
import { Rng } from './rng';
import {
  MODE_BIKE, MODE_CAR, MODE_PT, MODE_WALK, PURPOSE_HOME, PURPOSE_LEISURE, PURPOSE_LUNCH, PURPOSE_SCHOOL, PURPOSE_SHOP,
  PURPOSE_THROUGH, PURPOSE_WORK, type Agent, type Place, type Trip,
} from './agents';
import type { Transit } from './transit';

export interface DemandConfig {
  agents: number;
  seed: number;
  externalShare: number; // share of agents that commute in from outside the map
  throughShare: number; // pure through traffic relative to agents
  carShare: number; // scale for the car mode weight (e.g. policy: <1 = fewer car trips)
  startHour: number;
  endHour: number;
}

export const DEFAULT_DEMAND: DemandConfig = {
  agents: 12000,
  seed: 42,
  externalShare: 0.2,
  throughShare: 0.05,
  carShare: 1,
  startHour: 5,
  endHour: 24,
};

class Weighted {
  cum: number[] = [];
  items: number[] = [];
  total = 0;
  add(item: number, w: number) {
    if (w <= 0) return;
    this.total += w;
    this.cum.push(this.total);
    this.items.push(item);
  }
  pick(rng: Rng): number {
    const r = rng.next() * this.total;
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] < r) lo = m + 1; else hi = m;
    }
    return this.items[lo];
  }
  get size() {
    return this.items.length;
  }
}

interface Spot {
  x: number;
  y: number;
  w: number;
  kind: number;
  place?: Place;
}

export class DemandGenerator {
  private spots: Spot[] = [];
  private homes = new Weighted();
  private works = new Weighted();
  private edus = new Weighted();
  private shops = new Weighted();
  private food = new Weighted();
  private leisure = new Weighted();
  private gates: Place[] = [];
  private gateW = new Weighted();
  private placeCache = new Map<number, Place>();

  constructor(private net: Network, private transit: Transit | null) {
    const d = net.data;
    for (let i = 0; i < d.buildings.length; i++) {
      const b = d.buildings[i];
      let cx = 0, cy = 0, area = 0;
      const p = b.pts;
      const n = p.length / 2;
      for (let k = 0; k < n; k++) {
        const x0 = p[2 * k], y0 = p[2 * k + 1], x1 = p[2 * ((k + 1) % n)], y1 = p[2 * ((k + 1) % n) + 1];
        const cr = x0 * y1 - x1 * y0;
        area += cr;
        cx += (x0 + x1) * cr;
        cy += (y0 + y1) * cr;
      }
      area = Math.abs(area) / 2;
      if (area < 20) continue;
      const six = 6 * (area || 1);
      let px = cx / (3 * 2 * (area || 1)), py = cy / (3 * 2 * (area || 1));
      void six;
      if (!isFinite(px) || !isFinite(py) || Math.abs(px) > 1e5) {
        px = p[0]; py = p[1];
      }
      // centroid sign depends on winding: fall back to vertex mean when outside
      let mx = 0, my = 0;
      for (let k = 0; k < n; k++) { mx += p[2 * k]; my += p[2 * k + 1]; }
      mx /= n; my /= n;
      if (Math.hypot(px - mx, py - my) > 80) { px = mx; py = my; }
      const levels = Math.max(1, b.h / 3.2);
      const cap = Math.min(area, 1500) * levels;
      const si = this.spots.length;
      this.spots.push({ x: px, y: py, w: cap, kind: b.kind });
      const k = b.kind;
      if (k === 1) this.homes.add(si, cap / 40);
      else if (k === 0) {
        this.homes.add(si, cap / 70);
        this.works.add(si, cap / 60);
      }
      if (k === 2) this.works.add(si, cap / 30);
      if (k === 3) { this.works.add(si, cap / 40); this.shops.add(si, cap / 30); }
      if (k === 4) { this.edus.add(si, cap / 25); this.works.add(si, cap / 120); }
      if (k === 5) { this.works.add(si, cap / 25); }
    }
    for (const poi of d.pois) {
      const si = this.spots.length;
      this.spots.push({ x: poi.x, y: poi.y, w: 1, kind: 10 + poi.kind });
      if (poi.kind === 1) { this.shops.add(si, 3); this.works.add(si, 1.5); }
      if (poi.kind === 2) { this.food.add(si, 3); this.leisure.add(si, 2); this.works.add(si, 1.2); }
      if (poi.kind === 3) { this.leisure.add(si, 8); this.works.add(si, 2); }
      if (poi.kind === 4) { this.edus.add(si, 15); this.works.add(si, 2); }
      if (poi.kind === 5) { this.works.add(si, 20); }
      if (poi.kind === 6) { this.shops.add(si, 25); this.leisure.add(si, 4); }
    }
    if (this.shops.size === 0) for (let i = 0; i < Math.min(50, this.spots.length); i++) this.shops.add(i, 1);
    if (this.food.size === 0) this.food = this.shops;
    if (this.leisure.size === 0) this.leisure = this.shops;
    if (this.edus.size === 0) this.edus = this.works;
    // gates
    for (let n = 0; n < net.N; n++) {
      if (!net.nodeGate[n]) continue;
      const outs = net.outCar[n].filter((e) => net.edgeLen[e] > 12);
      const ins = net.inCar[n].filter((e) => net.edgeLen[e] > 12);
      if (!outs.length || !ins.length) continue;
      const oe = outs.reduce((a, b) => (net.edgeCls[b] > net.edgeCls[a] ? b : a));
      const ie = ins.reduce((a, b) => (net.edgeCls[b] > net.edgeCls[a] ? b : a));
      const w = Math.pow(2, net.edgeCls[oe]) * net.edgeLanes[oe];
      const pl: Place = {
        x: net.nodeX[n], y: net.nodeY[n], walkC: -1, walkS: 0,
        carE: oe, carS: 1, carEndE: ie, carEndS: net.edgeLen[ie] - 0.2,
        bikeE: -1, bikeS: 0, gate: true,
      };
      this.gateW.add(this.gates.length, w);
      this.gates.push(pl);
    }
  }

  private place(si: number): Place {
    let pl = this.placeCache.get(si);
    if (pl) return pl;
    const sp = this.spots[si];
    pl = this.snap(sp.x, sp.y);
    this.placeCache.set(si, pl);
    return pl;
  }

  snap(x: number, y: number): Place {
    const net = this.net;
    const walk = net.nearestEdge(x, y, (e) => net.edgeMode[e] === M_WALK || (net.edgeMode[e] === M_ROAD && (net.edgeFlags[e] & F_WALK) !== 0), 220);
    const car = net.nearestEdge(x, y, (e) => net.edgeMode[e] === M_ROAD && net.edgeLanes[e] > 0 && (net.edgeFlags[e] & F_CAR) !== 0 && net.edgeCls[e] <= 5 && net.edgeLen[e] > 14, 260);
    const bike = net.nearestEdge(x, y, (e) => net.edgeMode[e] === M_ROAD && (net.edgeFlags[e] & F_BIKE) !== 0 && net.edgeLen[e] > 8, 260);
    let walkC = -1, walkS = 0;
    if (walk) {
      const c = net.edgeRev[walk.edge] >= 0 ? Math.min(walk.edge, net.edgeRev[walk.edge]) : walk.edge;
      walkC = c;
      walkS = c === walk.edge ? walk.s : net.edgeLen[c] - walk.s;
    }
    const clampS = (e: number, s: number) => Math.max(4, Math.min(net.edgeLen[e] - 8, s));
    // alternate direction for two-way streets to avoid systematic bias
    const pick = (r: { edge: number; s: number } | null) => {
      if (!r) return { e: -1, s: 0 };
      let e = r.edge, s = r.s;
      if (net.edgeRev[e] >= 0 && ((x * 7 + y * 13) | 0) % 2 === 0) {
        s = net.edgeLen[e] - s;
        e = net.edgeRev[e];
      }
      return { e, s: clampS(e, s) };
    };
    const c = pick(car);
    const b = pick(bike);
    return { x, y, walkC, walkS, carE: c.e, carS: c.s, carEndE: c.e, carEndS: c.s, bikeE: b.e, bikeS: b.s, gate: false };
  }

  /** Choose a travel mode using distance based shares; returns MODE_* */
  private chooseMode(rng: Rng, dist: number, hasCar: boolean, ptOk: boolean, cfg: DemandConfig): number {
    const w = [0, 0, 0, 0];
    const km = dist / 1000;
    if (km < 0.25) w[MODE_WALK] = 1;
    else if (km < 1.0) { w[MODE_WALK] = 0.55; w[MODE_BIKE] = 0.2; w[MODE_CAR] = 0.2; w[MODE_PT] = 0.05; }
    else if (km < 2.5) { w[MODE_WALK] = 0.1; w[MODE_BIKE] = 0.36; w[MODE_CAR] = 0.34; w[MODE_PT] = 0.2; }
    else if (km < 6) { w[MODE_WALK] = 0.0; w[MODE_BIKE] = 0.27; w[MODE_CAR] = 0.45; w[MODE_PT] = 0.28; }
    else { w[MODE_BIKE] = 0.08; w[MODE_CAR] = 0.62; w[MODE_PT] = 0.3; }
    if (!hasCar) w[MODE_CAR] = 0;
    else w[MODE_CAR] *= cfg.carShare;
    if (!ptOk) w[MODE_PT] = 0;
    const tot = w[0] + w[1] + w[2] + w[3];
    if (tot <= 0) return MODE_WALK;
    let r = rng.next() * tot;
    for (let i = 0; i < 4; i++) {
      r -= w[i];
      if (r <= 0) return i;
    }
    return MODE_WALK;
  }

  private pickNear(rng: Rng, set: Weighted, x: number, y: number, scale: number): number {
    let best = -1, bw = -1;
    for (let k = 0; k < 10; k++) {
      const i = set.pick(rng);
      const s = this.spots[i];
      const d = Math.hypot(s.x - x, s.y - y);
      const w = Math.exp(-d / scale) * rng.next();
      if (w > bw) { bw = w; best = i; }
    }
    return best;
  }

  private commuteTime(dist: number, mode: number): number {
    const sp = mode === MODE_WALK ? 1.3 : mode === MODE_BIKE ? 4.2 : mode === MODE_CAR ? 6.5 : 5;
    return (dist * 1.3) / sp + (mode === MODE_CAR ? 240 : mode === MODE_PT ? 600 : 60);
  }

  generate(cfg: DemandConfig): Agent[] {
    const rng = new Rng(cfg.seed);
    const agents: Agent[] = [];
    const H = 3600;
    const make = (kind: number): Agent => {
      const a: Agent = { id: agents.length, kind, trips: [], ti: 0 };
      agents.push(a);
      return a;
    };
    const addTrip = (a: Agent, depart: number, from: Place, to: Place, mode: number, purpose: number) => {
      a.trips.push({ depart, from, to, mode, purpose });
    };
    const ptOk = (from: Place, to: Place) => !!this.transit && !!this.transit.plan(from.x, from.y, to.x, to.y);

    for (let n = 0; n < cfg.agents; n++) {
      const r = rng.next();
      const isExternal = r < cfg.externalShare;
      const homeSpot = this.homes.pick(rng);
      const homeP = isExternal ? this.gates[this.gateW.pick(rng)] : this.place(homeSpot);
      const hs = this.spots[homeSpot];
      const hasCar = isExternal ? true : rng.chance(0.72);
      const role = isExternal ? 3 : (() => { const q = rng.next(); return q < 0.55 ? 0 : q < 0.7 ? 1 : 2; })();
      const a = make(role);
      if (role === 0 || role === 3) {
        const wSpot = isExternal ? this.works.pick(rng) : this.pickNear(rng, this.works, hs.x, hs.y, 3500);
        const workP = this.place(wSpot);
        const ws = this.spots[wSpot];
        const dist = Math.hypot(ws.x - (isExternal ? homeP.x : hs.x), ws.y - (isExternal ? homeP.y : hs.y));
        let mode = isExternal ? (rng.chance(0.93) ? MODE_CAR : MODE_BIKE) : this.chooseMode(rng, dist, hasCar, ptOk(homeP, workP), cfg);
        if (isExternal && mode === MODE_BIKE) mode = MODE_CAR;
        if (mode === MODE_CAR && (workP.carE < 0 || homeP.carE < 0)) mode = MODE_BIKE;
        if (mode === MODE_BIKE && (workP.bikeE < 0 || (!isExternal && homeP.bikeE < 0))) mode = MODE_WALK;
        const shiftR = rng.next();
        let start = shiftR < 0.12 ? rng.normal(6.0 * H, 0.5 * H) : shiftR < 0.35 ? rng.normal(9.2 * H, 0.7 * H) : rng.normal(7.9 * H, 0.65 * H);
        start = Math.max(5 * H, start);
        const ct = this.commuteTime(isExternal ? dist + 6000 : dist, mode);
        addTrip(a, start - ct, homeP, workP, mode, PURPOSE_WORK);
        // lunch
        if (rng.chance(0.3)) {
          const fSpot = this.pickNear(rng, this.food, ws.x, ws.y, 500);
          const fp = this.place(fSpot);
          const fs = this.spots[fSpot];
          if (Math.hypot(fs.x - ws.x, fs.y - ws.y) < 900 && fp.walkC >= 0 && workP.walkC >= 0) {
            const lt = rng.normal(12.2 * H, 0.4 * H);
            addTrip(a, lt, workP, fp, MODE_WALK, PURPOSE_LUNCH);
            addTrip(a, lt + rng.range(2400, 3600), fp, workP, MODE_WALK, PURPOSE_LUNCH);
          }
        }
        const end = start + rng.normal(8.3 * H, 0.7 * H);
        if (rng.chance(0.35) && !isExternal) {
          const sSpot = this.pickNear(rng, rng.chance(0.65) ? this.shops : this.leisure, ws.x, ws.y, 2000);
          const sp = this.place(sSpot);
          const s2 = this.spots[sSpot];
          const m1 = mode === MODE_PT ? (ptOk(workP, sp) ? MODE_PT : MODE_WALK) : mode;
          addTrip(a, end, workP, sp, Math.hypot(s2.x - ws.x, s2.y - ws.y) < 400 ? MODE_WALK : m1, PURPOSE_SHOP);
          const dwell = rng.range(1800, 4500);
          const dist2 = Math.hypot(s2.x - hs.x, s2.y - hs.y);
          const m2 = mode === MODE_PT ? (ptOk(sp, homeP) ? MODE_PT : MODE_WALK) : dist2 < 400 ? MODE_WALK : mode;
          addTrip(a, end + dwell + this.commuteTime(Math.hypot(s2.x - ws.x, s2.y - ws.y), m1), sp, homeP, m2, PURPOSE_HOME);
        } else {
          addTrip(a, end, workP, homeP, mode, PURPOSE_HOME);
        }
      } else if (role === 1) {
        const eSpot = this.pickNear(rng, this.edus, hs.x, hs.y, 2500);
        const eduP = this.place(eSpot);
        const es = this.spots[eSpot];
        const dist = Math.hypot(es.x - hs.x, es.y - hs.y);
        let mode = this.chooseMode(rng, dist, hasCar && rng.chance(0.25), ptOk(homeP, eduP), cfg);
        if (mode === MODE_BIKE && (eduP.bikeE < 0 || homeP.bikeE < 0)) mode = MODE_WALK;
        if (mode === MODE_CAR && (eduP.carE < 0 || homeP.carE < 0)) mode = MODE_WALK;
        const start = rng.chance(0.7) ? rng.normal(7.75 * H, 0.2 * H) : rng.normal(9.2 * H, 0.8 * H);
        addTrip(a, start - this.commuteTime(dist, mode), homeP, eduP, mode, PURPOSE_SCHOOL);
        const back = rng.chance(0.5) ? rng.normal(13.2 * H, 0.5 * H) : rng.normal(16 * H, 1 * H);
        addTrip(a, back, eduP, homeP, mode, PURPOSE_HOME);
      } else {
        // non-working: errands
        const tour = (t0: number, pool: Weighted, purpose: number, scale: number) => {
          const sSpot = this.pickNear(rng, pool, hs.x, hs.y, scale);
          const sp = this.place(sSpot);
          const s2 = this.spots[sSpot];
          const dist = Math.hypot(s2.x - hs.x, s2.y - hs.y);
          let mode = this.chooseMode(rng, dist, hasCar, ptOk(homeP, sp), cfg);
          if (mode === MODE_BIKE && (sp.bikeE < 0 || homeP.bikeE < 0)) mode = MODE_WALK;
          if (mode === MODE_CAR && (sp.carE < 0 || homeP.carE < 0)) mode = MODE_WALK;
          if (mode === MODE_WALK && (sp.walkC < 0 || homeP.walkC < 0)) return;
          addTrip(a, t0, homeP, sp, mode, purpose);
          addTrip(a, t0 + rng.range(2400, 7200) + this.commuteTime(dist, mode), sp, homeP, mode, PURPOSE_HOME);
        };
        if (rng.chance(0.8)) tour(rng.normal(10 * H, 1.2 * H), this.shops, PURPOSE_SHOP, 1800);
        if (rng.chance(0.45)) tour(rng.normal(15.5 * H, 1.8 * H), this.leisure, PURPOSE_LEISURE, 2500);
      }
    }
    // through traffic
    const nThrough = Math.round(cfg.agents * cfg.throughShare);
    for (let n = 0; n < nThrough && this.gates.length > 1; n++) {
      const a = make(4);
      const g1 = this.gates[this.gateW.pick(rng)];
      let g2 = this.gates[this.gateW.pick(rng)];
      let guard = 0;
      while (Math.hypot(g1.x - g2.x, g1.y - g2.y) < 2500 && guard++ < 10) g2 = this.gates[this.gateW.pick(rng)];
      if (g1 === g2) continue;
      const peak = rng.next();
      const t = peak < 0.3 ? rng.normal(7.8 * H, 1 * H) : peak < 0.6 ? rng.normal(17 * H, 1.2 * H) : rng.range(6 * H, 22 * H);
      addTrip(a, t, g1, g2, MODE_CAR, PURPOSE_THROUGH);
    }
    // clean up: drop empty plans, sort trips
    const out: Agent[] = [];
    for (const a of agents) {
      if (!a.trips.length) continue;
      a.trips.sort((x: Trip, y: Trip) => x.depart - y.depart);
      // keep trips in the simulated window; if the outbound is clipped, drop the agent's trips before it
      const trips = a.trips.filter((t) => t.depart >= cfg.startHour * H && t.depart < cfg.endHour * H);
      a.trips = trips;
      a.id = out.length;
      if (trips.length) out.push(a);
    }
    return out;
  }
}
