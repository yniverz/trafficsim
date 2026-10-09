import type { Network } from './network';
import type { LineData } from './types';
import { TrafficEngine, VT_BUS, VT_TRAM, type Vehicle } from './engine';
import { PS_RIDING, PS_WALK, type Ped } from './agents';
import type { PedManager } from './peds';
import type { Metrics } from './metrics';
import { Rng } from './rng';

export interface LineRT {
  id: number;
  data: LineData;
  stops: { routeIdx: number; s: number; stop: number }[];
  nextDep: number;
  planned: number[]; // planned arrival offsets (s) at each stop relative to departure
  cumDist: number[]; // metres along the route at each stop
  runs: Map<number, number>; // vehicle id -> scheduled departure time
}

interface Waiting {
  ped: Ped;
  lineIds: number[];
  to: number;
  since: number;
}

export interface PtPlan {
  from: number;
  to: number;
  lineIds: number[];
  ride: number;
  walkIn: number;
  walkOut: number;
  wait: number;
}

export class Transit {
  lines: LineRT[] = [];
  waiting: Waiting[][];
  stopsServing = new Map<number, { line: number; idx: number }[]>();
  stopGrid = new Map<number, number[]>();
  private pending: { line: LineRT; sched: number }[] = [];
  private rng: Rng;
  private tramLen: number[] = [26, 30, 38, 45];
  waitingCount = 0;

  constructor(private net: Network, private eng: TrafficEngine, private peds: PedManager, private metrics: Metrics, seed = 5) {
    this.rng = new Rng(seed);
    const data = net.data;
    this.waiting = data.stops.map(() => []);
    for (const l of data.lines) {
      const stops = l.stops.map((s) => ({ routeIdx: s.routeIdx, s: data.stops[s.stop].s, stop: s.stop }));
      const planned: number[] = [];
      const cum: number[] = [];
      let acc = 0, idx = 0;
      const avg = l.mode === 'tram' ? 9.5 : 7.5;
      for (let i = 0; i < l.route.length; i++) {
        const len = net.edgeLen[l.route[i]];
        while (idx < stops.length && stops[idx].routeIdx === i) {
          const d = acc + stops[idx].s;
          planned.push(d / avg + idx * 18);
          cum.push(d);
          idx++;
        }
        acc += len;
      }
      const rt: LineRT = { id: l.id, data: l, stops, nextDep: 0, planned, cumDist: cum, runs: new Map() };
      this.lines.push(rt);
      stops.forEach((st, i) => {
        let a = this.stopsServing.get(st.stop);
        if (!a) this.stopsServing.set(st.stop, (a = []));
        a.push({ line: l.id, idx: i });
      });
    }
    data.stops.forEach((s) => {
      const k = Math.floor(s.x / 200) * 10007 + Math.floor(s.y / 200);
      let a = this.stopGrid.get(k);
      if (!a) this.stopGrid.set(k, (a = []));
      a.push(s.id);
    });
  }

  reset(startTime: number) {
    for (const l of this.lines) {
      const h = this.headway(l, startTime);
      l.nextDep = startTime + this.rng.range(0, Math.min(h, 1800));
      l.runs.clear();
    }
    this.pending.length = 0;
    for (const w of this.waiting) w.length = 0;
    this.waitingCount = 0;
  }

  headway(l: LineRT, t: number): number {
    const h = (t / 3600) % 24;
    const hw = l.data.headway;
    if (h < 5) return 1e9;
    if ((h >= 6.5 && h < 9) || (h >= 15.5 && h < 18.5)) return hw[0];
    if (h >= 9 && h < 15.5) return hw[1];
    if (h >= 18.5 && h < 23.5) return hw[2];
    if (h >= 5 && h < 6.5) return hw[3];
    return hw[3] * 1.5;
  }

  nearbyStops(x: number, y: number, r: number): number[] {
    const res: number[] = [];
    const cx = Math.floor(x / 200), cy = Math.floor(y / 200);
    const k = Math.ceil(r / 200);
    for (let dx = -k; dx <= k; dx++)
      for (let dy = -k; dy <= k; dy++) {
        const a = this.stopGrid.get((cx + dx) * 10007 + (cy + dy));
        if (!a) continue;
        for (const id of a) {
          const s = this.net.data.stops[id];
          if (Math.hypot(s.x - x, s.y - y) <= r) res.push(id);
        }
      }
    const stops = this.net.data.stops;
    return res.sort((a, b) => Math.hypot(stops[a].x - x, stops[a].y - y) - Math.hypot(stops[b].x - x, stops[b].y - y));
  }

  /** Best direct (no transfer) connection between two points, or null */
  plan(fx: number, fy: number, tx: number, ty: number): PtPlan | null {
    const A = this.nearbyStops(fx, fy, 700).slice(0, 5);
    const B = this.nearbyStops(tx, ty, 700).slice(0, 5);
    if (!A.length || !B.length) return null;
    const stops = this.net.data.stops;
    let best: PtPlan | null = null;
    let bestCost = Infinity;
    for (const a of A) {
      const sa = stops[a];
      const wa = Math.hypot(sa.x - fx, sa.y - fy) * 1.3;
      for (const b of B) {
        if (a === b) continue;
        const sb = stops[b];
        const wb = Math.hypot(sb.x - tx, sb.y - ty) * 1.3;
        const lines: number[] = [];
        let bestRide = Infinity;
        for (const sv of this.stopsServing.get(a) || []) {
          const line = this.lines[sv.line];
          const j = line.stops.findIndex((q, k) => k > sv.idx && q.stop === b);
          if (j < 0) continue;
          const ride = line.planned[j] - line.planned[sv.idx];
          lines.push(line.id);
          if (ride < bestRide) bestRide = ride;
        }
        if (!lines.length) continue;
        if (Math.hypot(sa.x - sb.x, sa.y - sb.y) < 350) continue;
        const hw = Math.min(...lines.map((id) => this.headway(this.lines[id], 8 * 3600)));
        const cost = (wa + wb) / 1.3 + bestRide + hw * 0.6;
        if (cost < bestCost) {
          bestCost = cost;
          best = { from: a, to: b, lineIds: lines, ride: bestRide, walkIn: wa, walkOut: wb, wait: hw * 0.5 };
        }
      }
    }
    return best;
  }

  addWaiting(p: Ped, stopId: number, lineIds: number[], to: number, t: number) {
    this.waiting[stopId].push({ ped: p, lineIds, to, since: t });
    this.waitingCount++;
  }

  // ------------------------------------------------------------- dispatching
  update(t: number) {
    for (const l of this.lines) {
      if (t >= l.nextDep) {
        this.pending.push({ line: l, sched: l.nextDep });
        const h = this.headway(l, t);
        l.nextDep += h;
        if (l.nextDep < t) l.nextDep = t + h;
      }
    }
    if (!this.pending.length) return;
    const keep: typeof this.pending = [];
    for (const pd of this.pending) {
      if (!this.spawn(pd.line, pd.sched, t)) keep.push(pd);
    }
    this.pending = keep;
  }

  private spawn(l: LineRT, sched: number, t: number): boolean {
    const route = l.data.route;
    const first = l.stops[0];
    const type = l.data.mode === 'tram' ? VT_TRAM : VT_BUS;
    const v = this.eng.makeVehicle(type, route, Math.max(0.5, first.s), this.net.edgeLen[route[route.length - 1]], () => this.rng.next());
    if (type === VT_TRAM) v.len = this.tramLen[this.rng.int(this.tramLen.length)];
    v.line = l;
    v.stopPtr = 0;
    v.persons = 1;
    v.tDepart = sched;
    v.owner = l;
    if (!this.eng.trySpawn(v, t)) return false;
    l.runs.set(v.id, sched);
    return true;
  }

  // ------------------------------------------------------------- engine hooks
  onDwell(v: Vehicle, stopIdx: number, t: number): number {
    const l = v.line as LineRT;
    const stopId = l.stops[stopIdx].stop;
    const sched = l.runs.get(v.id) ?? v.tDepart;
    const delay = t - (sched + l.planned[stopIdx]);
    if (stopIdx > 0) this.metrics.ptArrival(l.data.mode, delay);
    v.schedDelay = delay;
    let nAl = 0;
    const keep: Ped[] = [];
    for (const p of v.pax as Ped[]) {
      if (p.rideTo === stopId) {
        nAl++;
        p.vehicle = null;
        p.state = PS_WALK;
        this.peds.startLeg(p, p.li + 1);
      } else keep.push(p);
    }
    v.pax = keep;
    const cap = v.type === VT_TRAM ? 190 : 85;
    let nBd = 0;
    const w = this.waiting[stopId];
    for (let i = w.length - 1; i >= 0; i--) {
      const q = w[i];
      if (!q.lineIds.includes(l.id)) continue;
      const j = l.stops.findIndex((s, k) => k > stopIdx && s.stop === q.to);
      if (j < 0) continue;
      if (v.pax.length >= cap) break;
      w.splice(i, 1);
      this.waitingCount--;
      q.ped.state = PS_RIDING;
      q.ped.vehicle = v;
      q.ped.rideTo = q.to;
      v.pax.push(q.ped);
      this.metrics.boardings++;
      q.ped.waitedTotal += t - q.since;
      nBd++;
    }
    return 8 + 1.1 * (nAl + nBd) + (v.type === VT_TRAM ? 4 : 0);
  }

  onDwellEnd(_v: Vehicle, _idx: number, _t: number) {}

  onArrive(v: Vehicle, _t: number) {
    if (!v.line) return;
    const l = v.line as LineRT;
    l.runs.delete(v.id);
    for (const p of v.pax as Ped[]) {
      p.vehicle = null;
      p.state = PS_WALK;
      this.peds.startLeg(p, p.li + 1);
    }
    v.pax = [];
  }
}
