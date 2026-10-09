import { Network, M_WALK } from './network';
import type { NetworkData } from './types';
import { SignalSystem, type Strategy, type SignalParams } from './signals';
import { TrafficEngine, VT_BIKE, VT_CAR, type Vehicle } from './engine';
import { PedManager } from './peds';
import { Transit } from './transit';
import { Metrics } from './metrics';
import { DemandGenerator, DEFAULT_DEMAND, type DemandConfig } from './demand';
import {
  MODE_BIKE, MODE_CAR, MODE_PT, MODE_WALK, Ped, type Agent, type Leg, type Place, type Trip,
} from './agents';
import { Rng } from './rng';

export interface SimConfig {
  demand: DemandConfig;
  strategy: Strategy;
  signal: Partial<SignalParams>;
  seed: number;
  startTime: number; // s since midnight
}

export const DEFAULT_CONFIG: SimConfig = {
  demand: DEFAULT_DEMAND,
  strategy: 'fixed',
  signal: {},
  seed: 1,
  startTime: 5 * 3600,
};

interface PendingSpawn {
  v: Vehicle;
  agent: Agent;
  trip: Trip;
  since: number;
  sEndIdx: number;
}

export class Simulation {
  net: Network;
  sig!: SignalSystem;
  eng!: TrafficEngine;
  peds!: PedManager;
  transit!: Transit;
  metrics!: Metrics;
  demand: DemandGenerator;
  agents: Agent[] = [];
  t = 0;
  dt = 0.5;
  config: SimConfig;
  private departures: { t: number; agent: Agent; trip: Trip }[] = [];
  private dp = 0;
  private pendingSpawns: PendingSpawn[] = [];
  private rng!: Rng;
  private lastSeries = 0;
  private lastEma = 0;
  private lastCongestion = 0;
  private carCostCache: Float32Array;
  private tripSeq = 0;
  private walkCostCache: Float32Array;

  constructor(public data: NetworkData, config: Partial<SimConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config, demand: { ...DEFAULT_DEMAND, ...(config.demand || {}) } };
    this.net = new Network(data);
    this.carCostCache = new Float32Array(this.net.E);
    this.walkCostCache = new Float32Array(this.net.arcFrom.length);
    // walk costs: seconds incl. expected signal delays
    for (let a = 0; a < this.net.arcFrom.length; a++) this.walkCostCache[a] = this.net.arcLen[a] / 1.35;
    this.demand = new DemandGenerator(this.net, null);
    this.build();
  }

  /** (Re)create all dynamic state. Keeps the generated population when `keepAgents`. */
  build(keepAgents = false) {
    const cfg = this.config;
    this.rng = new Rng(cfg.seed);
    this.metrics = new Metrics();
    this.sig = new SignalSystem(this.net, cfg.seed);
    this.sig.strategy = cfg.strategy;
    this.sig.setParams(cfg.signal);
    this.sig.setStrategy(cfg.strategy);
    this.eng = new TrafficEngine(this.net, this.sig, {
      onArrive: (v, t) => this.onArrive(v, t),
      onDwell: (v, i, t) => this.transit.onDwell(v, i, t),
      onDwellEnd: (v, i, t) => this.transit.onDwellEnd(v, i, t),
    });
    this.peds = new PedManager(this.net, this.eng, this.sig, this.metrics, {
      onDone: (p, t) => this.pedDone(p, t),
      onArriveStop: (p, stop, leg, t) => this.transit.addWaiting(p, stop, leg.lineIds, leg.to, t),
    });
    this.transit = new Transit(this.net, this.eng, this.peds, this.metrics, cfg.seed + 5);
    this.demand = new DemandGenerator(this.net, this.transit);
    if (!keepAgents || !this.agents.length) this.agents = this.demand.generate(cfg.demand);
    this.t = cfg.startTime;
    this.dp = 0;
    this.pendingSpawns = [];
    this.departures = [];
    for (const a of this.agents) {
      a.ti = 0;
      for (const trip of a.trips) if (trip.depart >= this.t) this.departures.push({ t: trip.depart, agent: a, trip });
    }
    this.departures.sort((x, y) => x.t - y.t);
    this.transit.reset(this.t);
    this.lastSeries = this.t;
    this.lastEma = this.t;
    this.refreshCosts();
  }

  setStrategy(s: Strategy) {
    this.config.strategy = s;
    this.sig.setStrategy(s);
  }

  setSignalParams(p: Partial<SignalParams>) {
    Object.assign(this.config.signal, p);
    this.sig.setParams(p);
  }

  // ------------------------------------------------------------------ stepping
  step() {
    const dt = this.dt;
    const t = this.t;
    this.dispatch(t);
    this.retrySpawns(t);
    this.transit.update(t);
    this.peds.update(dt, t);
    this.sig.update(t, dt, this.eng.stats);
    this.eng.step(dt, t);
    this.t += dt;
    if (this.t - this.lastEma >= 20) {
      this.eng.updateEdgeSpeeds(0.35);
      this.lastEma = this.t;
    }
    if (this.t - this.lastCongestion >= 30) {
      this.refreshCosts();
      this.lastCongestion = this.t;
    }
    if (this.t - this.lastSeries >= 120) {
      this.sample();
      this.lastSeries = this.t;
    }
  }

  advance(seconds: number) {
    const end = this.t + seconds;
    while (this.t < end) this.step();
  }

  private sample() {
    this.metrics.teleports = this.eng.teleports;
    let sv = 0, n = 0, stopped = 0;
    for (const v of this.eng.vehicles) {
      if (v.type === VT_CAR) {
        sv += v.v;
        n++;
        if (v.v < 0.3) stopped++;
      }
    }
    let waiting = 0;
    for (const p of this.peds.peds) if (p.state === 1) waiting++;
    this.metrics.push({
      t: this.t, vehicles: this.eng.vehicleCount, meanSpeed: n ? sv / n : 0, stopped: n ? stopped / n : 0,
      peds: this.peds.count(), pedWaiting: waiting, ptDelay: 0, carDelay: 0,
    });
  }

  // ------------------------------------------------------------------ routing
  private refreshCosts() {
    const net = this.net;
    const ema = this.eng.edgeSpeedEma;
    for (let e = 0; e < net.E; e++) {
      const v = Math.max(1.2, Math.min(net.edgeSpeed[e], ema[e]));
      // signal expectation: constant delay at signalised ends
      this.carCostCache[e] = net.edgeLen[e] / v + (this.sig.hasSignal[net.edgeTo[e]] ? 8 : 1.5);
    }
  }

  private carRoute(from: Place, to: Place, perturb: boolean): { route: number[]; sStart: number; sEnd: number } | null {
    const net = this.net;
    const eng = this.eng;
    const a = from.carE, b = to.carEndE;
    if (a < 0 || b < 0) return null;
    const noise = perturb ? 0.12 : 0;
    const seed = this.rng.next();
    const cost = (e: number) => {
      if (eng.closed[e]) return Infinity;
      const base = this.carCostCache[e];
      return base * (1 + noise * (((e * 2654435761 + ((seed * 1e6) | 0)) >>> 0) % 1000) / 1000) + 0.0001;
    };
    if (a === b && from.carS < to.carEndS) return { route: [a], sStart: from.carS, sEnd: to.carEndS };
    const r = net.carRouter.routeNodes(net.edgeTo[a], net.edgeFrom[b], (e) => cost(e) );
    if (!r) return null;
    // avoid leading/trailing U-turn on same road
    const route = [a, ...r, b];
    if (a === b) return null;
    return { route, sStart: from.carS, sEnd: to.carEndS };
  }

  private bikeRoute(from: Place, to: Place): { route: number[]; sStart: number; sEnd: number } | null {
    const net = this.net;
    const a = from.bikeE, b = to.bikeE;
    if (a < 0 || b < 0) return null;
    if (a === b && from.bikeS < to.bikeS) return { route: [a], sStart: from.bikeS, sEnd: to.bikeS };
    if (a === b) return null;
    const r = net.bikeRouter.routeNodes(net.edgeTo[a], net.edgeFrom[b], (e) => {
      const infra = net.edgeFlags[e] & 128;
      const cls = net.edgeCls[e];
      let f = 1;
      if (net.edgeLanes[e] > 0 && !infra) f += cls >= 4 ? 0.8 : cls >= 3 ? 0.3 : 0;
      return (net.edgeLen[e] / 5) * f + 0.0001;
    });
    if (!r) return null;
    return { route: [a, ...r, b], sStart: from.bikeS, sEnd: to.bikeS };
  }

  /** walking path between two walk places */
  walkLeg(fc: number, fs: number, tc: number, ts: number): Leg | null {
    const net = this.net;
    if (fc < 0 || tc < 0) return null;
    const ka = net.arcOfEdge.get(fc)!, kb = net.arcOfEdge.get(tc)!;
    if (ka === undefined || kb === undefined) return null;
    const lenA = net.edgeLen[fc], lenB = net.edgeLen[tc];
    if (fc === tc) {
      // same edge
      if (ts >= fs) return { kind: 'walk', arcs: [2 * ka], sArc0: fs, sEnd: ts };
      return { kind: 'walk', arcs: [2 * ka + 1], sArc0: lenA - fs, sEnd: lenA - ts };
    }
    const wc = this.walkCostCache;
    const sources: [number, number][] = [[net.edgeFrom[fc], fs / 1.35], [net.edgeTo[fc], (lenA - fs) / 1.35]];
    const targets = new Map<number, number>();
    targets.set(net.edgeFrom[tc], ts / 1.35);
    const e2 = net.edgeTo[tc];
    const prev = targets.get(e2);
    const c2 = (lenB - ts) / 1.35;
    if (prev === undefined || c2 < prev) targets.set(e2, c2);
    const r = net.walkRouter.multi(sources, targets, (a) => wc[a] + (net.nodeSignal[net.arcTo[a]] ? 10 : net.nodeCross[net.arcTo[a]] ? 4 : 0));
    if (!r) return null;
    const arcs: number[] = [];
    // first partial arc along fc toward src
    if (r.src === net.edgeFrom[fc]) arcs.push(2 * ka + 1);
    else arcs.push(2 * ka);
    const sArc0 = r.src === net.edgeFrom[fc] ? lenA - fs : fs;
    for (const a of r.edges) arcs.push(a);
    // last partial arc along tc from dst
    let sEnd: number;
    if (r.dst === net.edgeFrom[tc]) { arcs.push(2 * kb); sEnd = ts; }
    else { arcs.push(2 * kb + 1); sEnd = lenB - ts; }
    return { kind: 'walk', arcs, sArc0, sEnd };
  }

  // ------------------------------------------------------------------ trips
  private dispatch(t: number) {
    while (this.dp < this.departures.length && this.departures[this.dp].t <= t) {
      const d = this.departures[this.dp++];
      this.startTrip(d.agent, d.trip, t);
    }
  }

  private startTrip(agent: Agent, trip: Trip, t: number) {
    let mode = trip.mode;
    const net = this.net;
    const fail = () => {
      this.metrics.stranded++;
    };
    if (mode === MODE_CAR || mode === MODE_BIKE) {
      const r = mode === MODE_CAR ? this.carRoute(trip.from, trip.to, true) : this.bikeRoute(trip.from, trip.to);
      if (!r) {
        mode = MODE_WALK;
      } else {
        const v = this.eng.makeVehicle(mode === MODE_CAR ? VT_CAR : VT_BIKE, r.route, r.sStart, r.sEnd, () => this.rng.next());
        v.owner = { agent, trip };
        v.tDepart = t;
        this.pendingSpawns.push({ v, agent, trip, since: t, sEndIdx: 0 });
        return;
      }
    }
    if (mode === MODE_PT) {
      const plan = this.transit.plan(trip.from.x, trip.from.y, trip.to.x, trip.to.y);
      const st = plan ? net.data.stops : null;
      let ok = false;
      if (plan && st && trip.from.walkC >= 0 && trip.to.walkC >= 0) {
        const sa = st[plan.from], sb = st[plan.to];
        const w1 = this.walkLeg(trip.from.walkC, trip.from.walkS, ...this.stopWalkPos(sa.walkEdge, sa.walkS));
        const w2 = this.walkLeg(...this.stopWalkPos(sb.walkEdge, sb.walkS), trip.to.walkC, trip.to.walkS);
        if (w1 && w2) {
          const p = new Ped();
          p.agent = agent; p.trip = trip; p.tDepart = t;
          p.legs = [w1, { kind: 'ride', from: plan.from, to: plan.to, lineIds: plan.lineIds }, w2];
          p.speed = this.walkSpeed();
          p.idealTime = plan.walkIn / p.speed + plan.walkOut / p.speed + plan.ride + plan.wait + 40;
          this.peds.add(p);
          ok = true;
        }
      }
      if (ok) return;
      mode = MODE_WALK;
    }
    if (mode === MODE_WALK) {
      const w = this.walkLeg(trip.from.walkC, trip.from.walkS, trip.to.walkC, trip.to.walkS);
      if (!w) return fail();
      const p = new Ped();
      p.agent = agent; p.trip = { ...trip, mode: MODE_WALK }; p.tDepart = t;
      p.legs = [w];
      p.speed = this.walkSpeed();
      this.peds.add(p);
    }
  }

  private stopWalkPos(e: number, s: number): [number, number] {
    const net = this.net;
    const c = net.edgeRev[e] >= 0 ? Math.min(e, net.edgeRev[e]) : e;
    return [c, c === e ? s : net.edgeLen[c] - s];
  }

  private walkSpeed() {
    return Math.max(0.9, this.rng.normal(1.36, 0.2));
  }

  private retrySpawns(t: number) {
    if (!this.pendingSpawns.length) return;
    const keep: PendingSpawn[] = [];
    for (const ps of this.pendingSpawns) {
      if (this.eng.trySpawn(ps.v, t)) {
        this.metrics.spawnWait += t - ps.since;
        this.metrics.spawnWaitN++;
      } else if (t - ps.since > 1200) {
        this.metrics.stranded++;
      } else keep.push(ps);
    }
    this.pendingSpawns = keep;
  }

  private onArrive(v: Vehicle, t: number) {
    if (v.line) {
      this.transit.onArrive(v, t);
      return;
    }
    const o = v.owner as { agent: Agent; trip: Trip };
    if (!o) return;
    const time = t - v.tDepart;
    const mode = v.type === VT_BIKE ? MODE_BIKE : MODE_CAR;
    const delay = time - v.freeFlow + v.penalty;
    let dist = 0;
    for (const e of v.route) dist += this.net.edgeLen[e];
    this.metrics.tripDone(mode, time, delay, dist);
  }

  private pedDone(p: Ped, t: number) {
    const time = t - p.tDepart;
    const m = p.trip.mode;
    if (m === MODE_PT) {
      this.metrics.tripDone(MODE_PT, time, time - p.idealTime, p.walkDist);
    } else {
      this.metrics.tripDone(MODE_WALK, time, p.waitedTotal, p.walkDist);
    }
  }

  // ------------------------------------------------------------------ decisions
  closeEdge(e: number, closed: boolean) {
    this.eng.closed[e] = closed ? 1 : 0;
    const rev = this.net.edgeRev[e];
    if (rev >= 0) this.eng.closed[rev] = closed ? 1 : 0;
    this.refreshCosts();
  }

  stats() {
    const e = this.eng;
    let cars = 0, bikes = 0, buses = 0, trams = 0;
    for (const v of e.vehicles) {
      if (v.type === 0) cars++;
      else if (v.type === 1) buses++;
      else if (v.type === 2) trams++;
      else bikes++;
    }
    return {
      t: this.t, cars, bikes, buses, trams, peds: this.peds.count(), pending: this.pendingSpawns.length,
      waitingAtStops: this.transit.waitingCount,
    };
  }
}

export { M_WALK };
