import { M_ROAD, type Network, LANE_W } from './network';
import type { TrafficEngine } from './engine';
import type { SignalSystem } from './signals';
import { Ped, PS_CROSSING, PS_RIDING, PS_WAITCROSS, PS_WALK, PS_WAITSTOP, type Leg } from './agents';
import type { Metrics } from './metrics';

export interface PedHooks {
  /** ped finished all legs */
  onDone(p: Ped, t: number): void;
  /** ped finished walking leg and next leg is a ride: register at stop */
  onArriveStop(p: Ped, stopId: number, leg: Extract<Leg, { kind: 'ride' }>, t: number): void;
}

export class PedManager {
  peds: Ped[] = [];
  private crossCache = new Map<number, any[]>();
  private nextId = 1;
  private now = 0;
  constructor(private net: Network, private eng: TrafficEngine, private sig: SignalSystem, private metrics: Metrics, private hooks: PedHooks) {}

  add(p: Ped) {
    p.id = this.nextId++;
    this.peds.push(p);
    this.startLeg(p, 0);
  }

  count() {
    let n = 0;
    for (const p of this.peds) if (p.state !== PS_RIDING && p.state !== PS_WAITSTOP) n++;
    return n;
  }

  /** begin leg `i` for ped (called initially and after alighting) */
  startLeg(p: Ped, i: number) {
    p.li = i;
    const leg = p.legs[i];
    if (!leg) return;
    if (leg.kind === 'walk') {
      p.arcs = leg.arcs;
      p.ai = 0;
      p.s = leg.sArc0;
      p.sEnd = leg.sEnd;
      p.state = PS_WALK;
    } else {
      p.state = PS_WAITSTOP;
      p.waitStopId = leg.from;
      p.boardWaitStart = this.now;
      this.hooks.onArriveStop(p, leg.from, leg, this.now);
    }
  }

  update(dt: number, t: number) {
    this.now = t;
    const net = this.net;
    this.sig.pedWaiting.fill(0);
    this.sig.pedOldest.fill(0);
    this.eng.pedWaitCount.fill(0);
    const list = this.peds;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (p.state === PS_RIDING || p.state === PS_WAITSTOP) continue;
      let done = false;
      if (p.state === PS_WALK) done = this.walk(p, dt, t);
      else if (p.state === PS_WAITCROSS) this.waitCross(p, dt, t);
      else if (p.state === PS_CROSSING) this.crossing(p, dt, t);
      if (done) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
    void net;
  }

  /** remove from active simulation (they live inside a vehicle or at a stop) */
  private walk(p: Ped, dt: number, t: number): boolean {
    const net = this.net;
    let move = p.speed * dt;
    let guard = 0;
    while (move > 0 && guard++ < 6) {
      const arc = p.arcs[p.ai];
      const c = net.walkCanon[arc >> 1];
      const len = net.edgeLen[c];
      const last = p.ai === p.arcs.length - 1;
      const limit = last ? p.sEnd : len;
      const remain = limit - p.s;
      if (move < remain) {
        p.s += move;
        p.walkDist += move;
        move = 0;
        break;
      }
      p.s = limit;
      p.walkDist += remain;
      move -= remain;
      if (last) {
        return this.legFinished(p, t);
      }
      // arrive at node
      const n = net.arcTo[arc];
      const nextArc = p.arcs[p.ai + 1];
      const arms = this.armsFor(n, arc, nextArc);
      if (arms.length === 0) {
        p.ai++;
        p.s = 0;
        continue;
      }
      // must cross
      p.state = PS_WAITCROSS;
      p.crossArms = arms;
      p.crossNode = n;
      p.waitingSince = t;
      this.poseAt(p, p);
      p.cx0 = p.x; p.cy0 = p.y;
      return false;
    }
    return false;
  }

  private armsFor(n: number, a: number, b: number): any[] {
    const key = (n * 40009 + a) * 40009 + b;
    let r = this.crossCache.get(key);
    if (!r) {
      r = this.net.crossedArms(n, a, b);
      this.crossCache.set(key, r);
    }
    return r;
  }

  private legFinished(p: Ped, t: number): boolean {
    const next = p.legs[p.li + 1];
    if (!next) {
      this.hooks.onDone(p, t);
      return true;
    }
    this.startLeg(p, p.li + 1);
    return false;
  }

  private waitCross(p: Ped, dt: number, t: number) {
    const n = p.crossNode;
    const waited = t - p.waitingSince;
    this.sig.pedWaiting[n]++;
    if (waited > this.sig.pedOldest[n]) this.sig.pedOldest[n] = waited;
    this.eng.pedWaitCount[n]++;
    // bring the ped to rest at the kerb
    let ok: boolean;
    if (this.sig.hasSignal[n]) ok = this.sig.pedOK(n, p.crossArms);
    else ok = this.gapOK(n, p.crossArms, waited);
    if (!ok) return;
    // start crossing
    let width = 0;
    for (const a of p.crossArms) {
      for (const idx of a.pedIdx) this.eng.pedBlock[idx]++;
      width += a.width;
    }
    p.crossDur = Math.max(2.5, width / 1.45 + 1);
    p.crossT = 0;
    p.state = PS_CROSSING;
    this.metrics.pedWait(waited, n);
    p.waitedTotal += waited;
    void dt;
  }

  private gapOK(n: number, arms: any[], waited: number): boolean {
    const net = this.net;
    const eng = this.eng;
    const patience = waited > 30 ? 0.6 : waited > 15 ? 0.8 : 1;
    const zebra = net.nodeCross[n] === 2;
    for (const a of arms) {
      for (const e of a.inEdges) {
        const w = eng.frontLane(e);
        if (!w) continue;
        const dW = net.edgeLen[e] - w.s - net.stopOff[e];
        if (dW < -1) return false; // already in the conflict area
        const brake = (w.v * w.v) / (2 * 3) + 1.5;
        if (zebra) {
          if (dW < brake && w.v > 2) return false;
        } else {
          if (w.v > 1.2 && dW < 55 && dW / w.v < 5.5 * patience) return false;
          if (w.v <= 1.2 && dW < 1.0) continue; // standing at the line: fine to cross in front
        }
      }
      // vehicles currently in the node box using this arm
      const ov = eng.occV[n];
      for (let i = 0; i < ov.length; i++) {
        if (waited > 40 && ov[i].v < 0.5) continue; // standing traffic: walk around it
        const oi = eng.occIn[n][i], oo = eng.occOut[n][i];
        for (const idx of a.pedIdx) {
          if (idx === oi * 2 || idx === oo * 2 + 1) return false;
        }
        if (a.outEdges.includes(oo) || a.inEdges.includes(oi)) return false;
      }
      // departing flow into this arm
      for (const e of a.outEdges) {
        void e;
      }
    }
    return true;
  }

  private crossing(p: Ped, dt: number, t: number) {
    p.crossT += dt;
    // interpolate to start of next arc
    const net = this.net;
    if (p.crossT >= p.crossDur) {
      for (const a of p.crossArms) for (const idx of a.pedIdx) this.eng.pedBlock[idx]--;
      p.ai++;
      p.s = 0;
      p.state = PS_WALK;
      p.crossArms = [];
      void net;
      void t;
      return;
    }
    // position interpolation
    const tmp = { x: 0, y: 0, h: 0 };
    this.poseArc(p.arcs[p.ai + 1], 0, tmp);
    const f = p.crossT / p.crossDur;
    p.x = p.cx0 + (tmp.x - p.cx0) * f;
    p.y = p.cy0 + (tmp.y - p.cy0) * f;
    p.h = Math.atan2(tmp.y - p.cy0, tmp.x - p.cx0);
  }

  // ------------------------------------------------------------------- pose
  poseArc(arc: number, s: number, out: { x: number; y: number; h: number }) {
    const net = this.net;
    const c = net.walkCanon[arc >> 1];
    const fwd = (arc & 1) === 0;
    const len = net.edgeLen[c];
    const sg = fwd ? s : len - s;
    let off = 1.3;
    if (net.edgeMode[c] === M_ROAD && net.edgeLanes[c] > 0) {
      const lanes = net.edgeLanes[c] * (net.edgeRev[c] >= 0 ? 2 : 1);
      off = (lanes * LANE_W) / 2 + 2.2;
    } else if (net.edgeMode[c] === M_ROAD) off = 1.8;
    else off = 0.6;
    // right of travel: for forward arcs +off in geometry frame, for reverse arcs -off
    net.pointAt(c, Math.min(Math.max(sg, 0), len), fwd ? off : -off, out);
    if (!fwd) out.h += Math.PI;
  }

  poseAt(p: Ped, out: { x: number; y: number; h: number }) {
    if (p.state === PS_CROSSING) {
      out.x = p.x; out.y = p.y; out.h = p.h;
      return;
    }
    const arc = p.arcs[p.ai];
    if (arc === undefined) return;
    this.poseArc(arc, p.s, out);
  }
}
