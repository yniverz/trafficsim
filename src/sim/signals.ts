import { F_CAR, M_ROAD, M_TRAM, type Network, type Arm } from './network';

export type Strategy = 'fixed' | 'actuated' | 'greenwave' | 'maxpressure' | 'smart';

export const STRATEGY_INFO: Record<Strategy, { label: string; blurb: string }> = {
  fixed: {
    label: 'Fixed-time (uncoordinated)',
    blurb: 'Classic Festzeit plan: every signal runs its own cycle with a random offset, regardless of demand. Roughly what an un-tuned network behaves like.',
  },
  actuated: {
    label: 'Vehicle-actuated',
    blurb: 'Detectors extend green while vehicles keep arriving and skip phases without demand.',
  },
  greenwave: {
    label: 'Green wave (coordinated)',
    blurb: 'Common cycle with offsets from the city centre so platoons on arterials meet green lights (grüne Welle).',
  },
  maxpressure: {
    label: 'Max-pressure (adaptive)',
    blurb: 'Each signal serves the phase that relieves the biggest queue, while avoiding feeding already congested downstream links.',
  },
  smart: {
    label: 'Smart: person-weighted + PT priority',
    blurb: 'Gap-out control that counts people instead of vehicles (a full tram outranks a car), pre-empts for trams and buses, never serves exits that are already full, and bounds the wait of every approach and of pedestrians.',
  },
};

export interface SignalParams {
  cycle: number; // fixed / green wave cycle length (s)
  tramPriority: boolean; // PT preemption
  pedMaxWait: number; // s; smart strategy bound on pedestrian waiting
  progressionSpeed: number; // m/s for green-wave offsets
  waveDirection: 'inbound' | 'outbound' | 'auto'; // which direction gets the progression
}

export interface TrafficStats {
  queue: Float32Array; // queued vehicle equivalents per edge near the stop line
  persons: Float32Array; // queued people per edge
  approach: Float32Array; // moving vehicles close to the stop line
  headStopped: Float32Array; // seconds the vehicle at the stop line has been standing still
  near: Float32Array; // all vehicles (queued or moving) within 110 m of the stop line, weighted
  nearPersons: Float32Array; // people in those vehicles
  tramDist: Float32Array; // distance of nearest tram to stop line (Infinity if none)
  busDist: Float32Array;
  count: Float32Array; // vehicles on edge
}

interface Phase {
  edges: number[];
  pedOnly: boolean;
  tramOnly: boolean;
  weight: number;
}

const off = (k: string): boolean => ((globalThis as any).SMART_OFF || '').includes(k);
const YELLOW = 3;
const ALLRED = 1.5;
const LOST = YELLOW + ALLRED;

class Controller {
  phases: Phase[] = [];
  disp = 0; // displayed phase
  sub = 0; // 0 green, 1 yellow, 2 all-red
  t = 0; // time in sub state
  target = 0; // phase we are heading to
  plan: number[] = []; // fixed green durations
  cycle = 90;
  offset = 0;
  mainPhase = 0;
  lastPreempt = -999;
  preemptPhase = -1;
  preemptStart = 0;
  lastServed: number[] = [];
  pedWait = 0; // s since oldest waiting pedestrian started waiting (0 if none)
  constructor(public node: number) {}
}

export class SignalSystem {
  controllers: Controller[] = [];
  byNode = new Map<number, Controller>();
  status: Uint8Array;
  strategy: Strategy = 'fixed';
  params: SignalParams = { cycle: 90, tramPriority: false, pedMaxWait: 45, progressionSpeed: 12, waveDirection: 'auto' };
  pedWaiting: Int16Array; // per node, maintained by pedestrians
  pedOldest: Float32Array; // per node, longest wait
  private edgePhase: Int16Array; // edge -> phase index at its node (or -1)
  hasSignal: Uint8Array;

  constructor(private net: Network, seed = 1) {
    this.status = new Uint8Array(net.E).fill(1);
    this.pedWaiting = new Int16Array(net.N);
    this.pedOldest = new Float32Array(net.N);
    this.edgePhase = new Int16Array(net.E).fill(-1);
    this.hasSignal = new Uint8Array(net.N);
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let n = 0; n < net.N; n++) {
      if (!net.nodeSignal[n]) continue;
      const c = this.build(n);
      if (!c) continue;
      c.offset = rnd() * 90;
      this.controllers.push(c);
      this.byNode.set(n, c);
      this.hasSignal[n] = 1;
    }
    this.configure();
  }

  private build(n: number): Controller | null {
    const net = this.net;
    const ins = net.inAll[n];
    if (ins.length === 0) return null;
    const c = new Controller(n);
    // cluster by axis
    const axes: { axis: number; edges: number[] }[] = [];
    for (const e of ins) {
      let a = net.headingEnd(e) % Math.PI;
      if (a < 0) a += Math.PI;
      let hit = axes.find((x) => Math.min(Math.abs(x.axis - a), Math.PI - Math.abs(x.axis - a)) < 0.62);
      if (!hit) axes.push((hit = { axis: a, edges: [] }));
      hit.edges.push(e);
    }
    // merge tram-only axes that exactly align to a road axis is done by tolerance above
    for (const ax of axes) {
      const tramOnly = ax.edges.every((e) => net.edgeMode[e] === M_TRAM);
      let weight = 0;
      for (const e of ax.edges) {
        if (net.edgeMode[e] === M_TRAM) weight += 1.2;
        else weight += Math.max(0.5, net.edgeLanes[e]) * (0.6 + net.edgeCls[e] / 4);
      }
      c.phases.push({ edges: ax.edges, pedOnly: false, tramOnly, weight });
    }
    // order phases by axis angle for stable cycling
    // a lone phase gets a pedestrian phase so crossings can be served
    if (c.phases.length === 1) c.phases.push({ edges: [], pedOnly: true, tramOnly: false, weight: 0.5 });
    c.phases.forEach((p, i) => p.edges.forEach((e) => (this.edgePhase[e] = i)));
    c.lastServed = c.phases.map(() => 0);
    c.mainPhase = c.phases.reduce((b, p, i) => (p.weight > c.phases[b].weight ? i : b), 0);
    return c;
  }

  setStrategy(s: Strategy) {
    this.strategy = s;
    this.configure();
  }

  setParams(p: Partial<SignalParams>) {
    Object.assign(this.params, p);
    this.configure();
  }

  /** (Re)compute fixed plans and green-wave offsets for the current strategy/params. */
  configure() {
    const coordinated = this.strategy === 'greenwave';
    if (coordinated) this.waveInbound = this.params.waveDirection === 'auto' ? (this.lastTime / 3600) % 24 < 12.5 : this.params.waveDirection === 'inbound';
    const C0 = this.params.cycle;
    for (const c of this.controllers) {
      c.mainPhase = c.phases.reduce((b, p, i) => (p.weight > c.phases[b].weight ? i : b), 0);
      this.makePlan(c, C0, false);
    }
    if (coordinated) this.computeOffsets(C0);
    else {
      let s = 7;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (const c of this.controllers) c.offset = rnd() * c.cycle;
    }
  }

  private makePlan(c: Controller, C0: number, coordinated: boolean) {
    const k = c.phases.length;
    const sumW = c.phases.reduce((a, p) => a + p.weight, 0);
    const minG = c.phases.map((p) => (p.pedOnly ? 8 : p.tramOnly ? 7 : 9));
    const avail = Math.max(k * 10, C0 - k * LOST);
    let greens = c.phases.map((p, i) => Math.max(minG[i], (avail * p.weight) / sumW));
    c.plan = greens;
    c.cycle = greens.reduce((a, g) => a + g + LOST, 0);
    if (coordinated) {
      const f = C0 / c.cycle;
      if (Math.abs(f - 1) > 0.001) {
        c.plan = c.plan.map((g) => Math.max(5, (g + LOST) * f - LOST));
        c.cycle = c.plan.reduce((a, g) => a + g + LOST, 0);
      }
    }
  }

  private waveInbound = true;

  private phaseForHeading(c: Controller, heading: number): number {
    let a = heading % Math.PI;
    if (a < 0) a += Math.PI;
    let best = c.mainPhase, bd = 1e9;
    c.phases.forEach((ph, i) => {
      if (!ph.edges.length) return;
      let b = this.net.headingEnd(ph.edges[0]) % Math.PI;
      if (b < 0) b += Math.PI;
      const d = Math.min(Math.abs(a - b), Math.PI - Math.abs(a - b));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Offsets so that the favoured green progresses along arterials towards (morning) or away from (evening) the centre. */
  private computeOffsets(cycle: number) {
    const net = this.net;
    interface Link { to: number; dist: number; headOut: number; headIn: number }
    const links = new Map<number, Link[]>();
    for (const c of this.controllers) {
      const l: Link[] = [];
      for (const e0 of net.outCar[c.node]) {
        if (net.edgeCls[e0] < 3) continue;
        let e = e0;
        let dist = net.edgeLen[e];
        for (let hop = 0; hop < 8; hop++) {
          const m = net.edgeTo[e];
          if (this.byNode.has(m) && m !== c.node) {
            l.push({ to: m, dist, headOut: net.headingStart(e0), headIn: net.headingEnd(e) });
            break;
          }
          let best = -1, ba = 1e9;
          for (const f of net.outCar[m]) {
            if (net.edgeCls[f] < 3 || f === net.edgeRev[e]) continue;
            const a = Math.abs(net.turnAngle(e, f));
            if (a < ba) { ba = a; best = f; }
          }
          if (best < 0 || ba > 0.9) break;
          e = best;
          dist += net.edgeLen[e];
          if (dist > 900) break;
        }
      }
      links.set(c.node, l);
    }
    // reverse index
    const incoming = new Map<number, { from: number; link: Link }[]>();
    for (const [from, ls] of links) for (const lk of ls) {
      let a = incoming.get(lk.to);
      if (!a) incoming.set(lk.to, (a = []));
      a.push({ from, link: lk });
    }
    const T = (d: number) => d / this.params.progressionSpeed;
    const sorted = [...this.controllers].sort((a, b) => Math.hypot(net.nodeX[a.node], net.nodeY[a.node]) - Math.hypot(net.nodeX[b.node], net.nodeY[b.node]));
    const S = new Map<number, number>(); // time in cycle when favoured green starts
    const queue: number[] = [];
    const sign = this.waveInbound ? -1 : 1; // outward step adds T (outbound) or subtracts T (inbound)
    for (const root of sorted) {
      if (S.has(root.node)) continue;
      // root: favoured phase = highest weight
      S.set(root.node, 0);
      queue.push(root.node);
      while (queue.length) {
        const n = queue.shift()!;
        const sn = S.get(n)!;
        const visit = (m: number, d: number, headAtM: number) => {
          if (S.has(m)) return;
          const cm = this.byNode.get(m)!;
          cm.mainPhase = this.phaseForHeading(cm, headAtM);
          S.set(m, (((sn + sign * T(d)) % cycle) + cycle) % cycle);
          queue.push(m);
        };
        for (const lk of links.get(n) || []) visit(lk.to, lk.dist, lk.headIn);
        for (const inc of incoming.get(n) || []) visit(inc.from, inc.link.dist, inc.link.headOut);
      }
    }
    for (const c of this.controllers) {
      this.makePlan(c, cycle, S.has(c.node));
      let startMain = 0;
      for (let i = 0; i < c.mainPhase; i++) startMain += c.plan[i] + LOST;
      startMain += LOST;
      const want = S.get(c.node) ?? 0;
      c.offset = (((startMain - want) % c.cycle) + c.cycle) % c.cycle;
    }
  }

  reset() {
    for (const c of this.controllers) {
      c.disp = 0;
      c.sub = 0;
      c.t = 0;
      c.target = 0;
      c.lastServed.fill(0);
    }
  }

  // ------------------------------------------------------------------ per step
  update(t: number, dt: number, st: TrafficStats) {
    const strat = this.strategy;
    this.lastTime = t;
    if (strat === 'greenwave') {
      const want = this.params.waveDirection === 'auto' ? (t / 3600) % 24 < 12.5 : this.params.waveDirection === 'inbound';
      if (want !== this.waveInbound) {
        this.waveInbound = want;
        this.configure();
      }
    }
    for (const c of this.controllers) {
      const desired = this.desired(c, t, st, strat);
      this.advance(c, desired, dt, strat);
      this.write(c);
    }
  }

  private desired(c: Controller, t: number, st: TrafficStats, strat: Strategy): number {
    const k = c.phases.length;
    // preemption for trams (and buses in smart mode)
    if (this.params.tramPriority && strat !== 'smart') {
      const p = this.preemptTarget(c, st, false);
      if (p >= 0) {
        if (c.preemptPhase !== p) {
          if (t - c.lastPreempt > 25) { c.preemptPhase = p; c.preemptStart = t; }
        }
      }
      if (c.preemptPhase >= 0) {
        const still = this.phaseHasTram(c, c.preemptPhase, st, false);
        if (t - c.preemptStart > 28 || (!still && t - c.preemptStart > 6)) {
          c.preemptPhase = -1;
          c.lastPreempt = t;
        } else return c.preemptPhase;
      }
    }
    switch (strat) {
      case 'fixed':
      case 'greenwave': {
        let tc = (t + c.offset) % c.cycle;
        let p = 0;
        for (let i = 0; i < k; i++) {
          const d = c.plan[i] + LOST;
          if (tc < d) { p = i; break; }
          tc -= d;
        }
        // pedestrian-only and tram-only stages are call-actuated, as at real crossings
        for (let guard = 0; guard < k; guard++) {
          const ph = c.phases[p];
          const called = ph.pedOnly ? this.pedWaiting[c.node] > 0 : ph.tramOnly ? this.phaseHasTram(c, p, st, false) : true;
          if (called) break;
          p = (p + k - 1) % k;
        }
        return p;
      }
      case 'actuated':
        return this.actuated(c, st);
      case 'maxpressure':
        return this.pressure(c, t, st, false);
      case 'smart':
        return this.smartDemand(c, t, st);
    }
  }

  private phaseHasTram(c: Controller, p: number, st: TrafficStats, includeBus: boolean): boolean {
    for (const e of c.phases[p].edges) {
      if (st.tramDist[e] < 110) return true;
      if (includeBus && st.busDist[e] < 70) return true;
    }
    return false;
  }

  private preemptTarget(c: Controller, st: TrafficStats, includeBus: boolean): number {
    let best = -1, bd = 1e9;
    for (let p = 0; p < c.phases.length; p++) {
      for (const e of c.phases[p].edges) {
        const d = Math.min(st.tramDist[e], includeBus ? st.busDist[e] : Infinity);
        if (d < 110 && d < bd) { bd = d; best = p; }
      }
    }
    return best;
  }

  private demandOf(c: Controller, p: number, st: TrafficStats): number {
    let q = 0;
    for (const e of c.phases[p].edges) q += st.queue[e] + st.approach[e] * 0.5 + (st.tramDist[e] < 110 ? 3 : 0);
    if (c.phases[p].pedOnly || true) {
      // pedestrians wait for a phase in which their arm is red: any other phase serves them
    }
    return q;
  }

  /** green is on but nobody at the stop line can move (blocked exit, conflicting vehicle ...) */
  private stalled(c: Controller, st: TrafficStats): boolean {
    if (c.sub !== 0 || c.t < 12) return false;
    const ph = c.phases[c.disp];
    let any = false;
    for (const e of ph.edges) {
      if (st.count[e] === 0) continue;
      any = true;
      if (st.headStopped[e] < 9) return false;
    }
    return any;
  }

  private actuated(c: Controller, st: TrafficStats): number {
    const k = c.phases.length;
    const cur = c.disp;
    if (c.sub !== 0) return c.target;
    const ph = c.phases[cur];
    const greenT = c.t;
    const hasDemandHere = this.demandOf(c, cur, st) > 0.01 && !this.stalled(c, st);
    // extend while vehicles are arriving, up to max green
    const minGreen = ph.tramOnly ? 5 : 7;
    const maxGreen = ph.tramOnly ? 20 : 45;
    if (greenT < minGreen) return cur;
    if (hasDemandHere && greenT < maxGreen) {
      // someone is still being served
      let other = false;
      for (let i = 0; i < k; i++) if (i !== cur && this.demandOf(c, i, st) > 0.01) other = true;
      if (other || greenT < minGreen + 3) return cur;
    }
    // choose the next phase with demand, cyclically
    for (let j = 1; j < k; j++) {
      const i = (cur + j) % k;
      if (this.demandOf(c, i, st) > 0.01 || (c.phases[i].pedOnly && this.pedWaiting[c.node] > 0)) return i;
    }
    // pedestrians waiting while only the current phase has vehicles: give them a window after max green
    if (this.pedWaiting[c.node] > 0 && greenT > 15) return (cur + 1) % k;
    return cur;
  }


  /**
   * "Smart" control: actuated gap-out logic that
   *  - measures demand in people (a full tram or bus outweighs a car),
   *  - never serves a phase whose exit links are already full (no spill-back / blocking the box),
   *  - caps the red time of every approach (aging) and the wait of pedestrians,
   *  - gives trams and buses early or extended green via detector pre-emption (handled in desired()).
   */
  private smartDemand(c: Controller, t: number, st: TrafficStats): number {
    const k = c.phases.length;
    if (c.sub !== 0) return c.target;
    const cur = c.disp;
    const g = c.t;
    const net = this.net;
    const dem: number[] = [];
    for (let p = 0; p < k; p++) {
      const ph = c.phases[p];
      let d = 0;
      let blocked = 0, n = 0;
      for (const e of ph.edges) {
        if (net.edgeMode[e] === M_TRAM) { if (st.tramDist[e] < 150) d += 12; continue; }
        d += st.persons[e] + st.approach[e] * 1.3;
        for (const f of net.outCar[net.edgeTo[e]]) {
          if (f === net.edgeRev[e]) continue;
          const cap = Math.max(1, (net.edgeLen[f] * Math.max(1, net.edgeLanes[f])) / 7.5);
          n++;
          if (st.count[f] / cap > 0.92) blocked++;
        }
      }
      if (!off('gate') && n > 0 && blocked / n > 0.7) d *= 0.25; // exit links full: serving them only creates blocking
      dem.push(d);
    }
    const aged = dem.map((d, p) => (d < 0.05 ? 0 : d + (p === cur || off('age') ? 0 : Math.max(0, t - c.lastServed[p] - 25) * 0.12)));
    const pedWait = this.pedOldest[c.node];
    const pedFlag = this.pedWaiting[c.node] > 0;
    const minGreen = c.phases[cur].tramOnly ? 5 : 7;
    if (g < minGreen) return cur;
    // pedestrian guarantee: nobody waits longer than pedMaxWait
    if (!off('ped') && pedFlag && pedWait > this.params.pedMaxWait && k > 1) {
      let best = -1, bs = -1;
      for (let p = 0; p < k; p++) {
        if (p === cur) continue;
        const sc = aged[p] + (c.phases[p].pedOnly ? 5 : 0);
        if (sc > bs) { bs = sc; best = p; }
      }
      if (best >= 0) return best;
    }
    let best = cur, bs = -1;
    for (let p = 0; p < k; p++) if (p !== cur && aged[p] > bs) { bs = aged[p]; best = p; }
    const here = this.stalled(c, st) ? 0 : dem[cur];
    if (here > 0.3 && g < 50) return cur; // gap-out: keep serving while people keep arriving
    if (best !== cur && bs > 0.3) return best;
    if (!off('pedcyc') && pedFlag && g > 10 && k > 1) return (cur + 1) % k;
    return cur;
  }

  private pressure(c: Controller, t: number, st: TrafficStats, smart: boolean): number {
    const k = c.phases.length;
    if (c.sub !== 0) return c.target;
    const cur = c.disp;
    const greenT = c.t;
    const minGreen = 10;
    const net = this.net;
    // tram / bus priority
    if (this.params.tramPriority || smart) {
      const p = this.preemptTarget(c, st, smart);
      if (p >= 0 && p !== cur && greenT >= 5 && t - c.lastPreempt > 20) {
        c.lastPreempt = t - 5;
        return p;
      }
      if (p === cur) return cur;
    }
    if (greenT < minGreen) return cur;
    const scores: number[] = [];
    for (let p = 0; p < k; p++) {
      const ph = c.phases[p];
      let s = 0;
      for (const e of ph.edges) {
        const own = smart ? st.nearPersons[e] : st.near[e];
        // downstream density penalty (spill-back protection)
        const out = net.outCar[net.edgeTo[e]];
        let down = 0, nd = 0;
        for (const f of out) {
          if (net.edgeMode[e] === M_TRAM) break;
          const cap = Math.max(1, (net.edgeLen[f] * Math.max(1, net.edgeLanes[f])) / 7.5);
          down += Math.min(1.2, st.count[f] / cap);
          nd++;
        }
        const dens = nd ? down / nd : 0;
        s += own * (1 - 0.6 * Math.min(1, dens));
        if (st.tramDist[e] < 150) s += smart ? 14 : 6;
      }
      // starvation guard: rises with time since served
      const waited = t - c.lastServed[p];
      if (s > 0.05) s += Math.max(0, waited - 35) * 0.12;
      // pedestrians: any phase except the one blocking them benefits them
      if (this.pedWaiting[c.node] > 0) {
        const pedBoost = smart ? 1.6 : 0.5;
        const longest = this.pedOldest[c.node];
        if (ph.pedOnly) s += pedBoost * this.pedWaiting[c.node] + longest * 0.15;
        else if (p !== cur) s += pedBoost * 0.5 * Math.min(this.pedWaiting[c.node], 8);
        if (smart && longest > this.params.pedMaxWait && p !== cur) s += 25;
      }
      scores.push(s);
    }
    let best = cur;
    for (let p = 0; p < k; p++) if (scores[p] > scores[best]) best = p;
    if (best === cur) return cur;
    const maxGreen = smart ? 55 : 70;
    if (scores[best] > scores[cur] * 1.1 + 0.8 || greenT > maxGreen) return best;
    return cur;
  }

  /** shared display machine: min green, yellow, all-red */
  private advance(c: Controller, desired: number, dt: number, strat: Strategy) {
    c.t += dt;
    if (c.sub === 0) {
      c.lastServed[c.disp] = this.lastTime;
      if (desired !== c.disp) {
        const minG = strat === 'fixed' || strat === 'greenwave' ? 3 : 5;
        if (c.t >= minG) {
          c.sub = 1; c.t = 0; c.target = desired;
        }
      }
    } else if (c.sub === 1) {
      if (c.t >= YELLOW) { c.sub = 2; c.t = 0; }
    } else {
      if (c.t >= ALLRED) {
        c.sub = 0; c.t = 0; c.disp = c.target;
        c.lastServed[c.disp] = this.lastTime;
      }
    }
  }
  lastTime = 0;

  private write(c: Controller) {
    const ph = c.phases;
    for (let p = 0; p < ph.length; p++) {
      const v = c.sub === 0 ? (p === c.disp ? 1 : 0) : c.sub === 1 ? (p === c.disp ? 2 : 0) : 0;
      for (const e of ph[p].edges) this.status[e] = v;
    }
  }

  // ------------------------------------------------------------------ pedestrians
  /** May pedestrians start crossing these arms now? */
  pedOK(node: number, arms: Arm[]): boolean {
    const c = this.byNode.get(node);
    if (!c) return true;
    if (c.sub !== 0 && c.sub !== 2) return false;
    if (c.sub === 0 && c.t < 1) return false;
    if (c.sub === 0 && c.disp >= 0 && c.target !== c.disp) return false;
    for (const a of arms) {
      for (const e of a.inEdges) if (this.status[e] !== 0) return false;
    }
    return true;
  }

  /** current display state for rendering: 0 red, 1 green, 2 yellow for a given in-edge */
  light(e: number): number {
    return this.status[e];
  }

  /** The current planned wave information for UI */
  summary() {
    return { count: this.controllers.length };
  }

  isRoadEdge(e: number) {
    return this.net.edgeMode[e] === M_ROAD && (this.net.edgeFlags[e] & F_CAR) !== 0;
  }
}
