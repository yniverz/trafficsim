import {
  F_ROUNDABOUT, M_TRAM, TURN_LEFT, TURN_RIGHT, TURN_THROUGH, type Network,
} from './network';
import type { SignalSystem, TrafficStats } from './signals';

export const VT_CAR = 0;
export const VT_BUS = 1;
export const VT_TRAM = 2;
export const VT_BIKE = 3;

interface VParams {
  len: number; a: number; b: number; T: number; s0: number; vmax: number; maxDecel: number; commitDecel: number;
}
const PARAMS: VParams[] = [
  { len: 4.5, a: 1.9, b: 2.8, T: 1.2, s0: 2, vmax: 36, maxDecel: 9, commitDecel: 5.5 },
  { len: 12, a: 1.1, b: 2.2, T: 1.4, s0: 2.5, vmax: 14, maxDecel: 6, commitDecel: 3.8 },
  { len: 30, a: 1.0, b: 1.5, T: 1.5, s0: 3, vmax: 17, maxDecel: 3.0, commitDecel: 2.7 },
  { len: 1.8, a: 1.1, b: 2.0, T: 0.9, s0: 1.0, vmax: 6.5, maxDecel: 5, commitDecel: 3.5 },
];

export class Vehicle {
  id = 0;
  type = 0;
  len = 4.5;
  edge = -1;
  lane = 0;
  s = 0;
  v = 0;
  acc = 0;
  route: number[] = [];
  ri = 0;
  sEnd = 0;
  a = 1.9; b = 2.8; T = 1.2; s0 = 2;
  vmax = 36;
  v0f = 1;
  maxDecel = 9;
  commitDecel = 5.5;
  nextLane = 0;
  nextLaneFor = -1;
  occN: number[] = [];
  occIn: number[] = [];
  occOut: number[] = [];
  wait = 0; // seconds waiting near a stop line
  stopped = 0; // seconds with ~zero speed
  owner: any = null;
  // trip accounting
  tDepart = 0;
  tSpawn = 0;
  freeFlow = 0;
  persons = 1;
  // public transport
  line: any = null;
  stopPtr = 0;
  dwell = -1; // >=0: currently dwelling, remaining time
  pax: any[] = [];
  schedDelay = 0;
  x = 0; y = 0; h = 0; // last rendered pose (filled by engine on demand)
  penalty = 0; // seconds added to the trip delay (e.g. teleport after gridlock)
  moved = -1; // step counter stamp: prevents moving twice in one step
  alive = false;
}

export interface EngineHooks {
  onArrive(v: Vehicle, t: number): void;
  /** called when a PT vehicle starts dwelling at its next stop; return dwell duration in seconds */
  onDwell(v: Vehicle, stopIdx: number, t: number): number;
  onDwellEnd(v: Vehicle, stopIdx: number, t: number): void;
}

const tmpPt = { x: 0, y: 0, h: 0 };

export class TrafficEngine {
  lanes: Vehicle[][][];
  bikes: Vehicle[][];
  cnt: Int32Array;
  occV: Vehicle[][];
  occIn: number[][];
  occOut: number[][];
  pedBlock: Int16Array;
  pedWaitCount: Int16Array;
  stats: TrafficStats;
  edgeSpeedEma: Float32Array;
  closed: Uint8Array; // closed edges (decision tool)
  speedScale = 1;
  vehicleCount = 0;
  private active: number[] = [];
  private all: Vehicle[] = [];
  private nextId = 1;
  private pool: Vehicle[] = [];
  why = 0;
  private frontCache: (Vehicle | null)[];
  private sumV: Float32Array;
  private nV: Int32Array;
  private sigNodeOfEdge: Uint8Array;
  /** accumulated vehicle-seconds lost to standstill, per edge, for heatmaps */
  stopTime: Float32Array;
  totalStopSeconds = 0;

  constructor(public net: Network, public sig: SignalSystem, public hooks: EngineHooks) {
    const E = net.E;
    this.lanes = new Array(E);
    this.bikes = new Array(E);
    for (let e = 0; e < E; e++) {
      const m = net.edgeMode[e];
      if (m === M_TRAM || net.edgeLanes[e] > 0) {
        const L = net.edgeLanes[e];
        this.lanes[e] = Array.from({ length: L }, () => []);
      } else this.lanes[e] = [];
      this.bikes[e] = [];
    }
    this.cnt = new Int32Array(E);
    this.occV = net.data.nodes.map(() => []);
    this.occIn = net.data.nodes.map(() => []);
    this.occOut = net.data.nodes.map(() => []);
    this.pedBlock = new Int16Array(E * 2);
    this.pedWaitCount = new Int16Array(net.N);
    this.stats = {
      queue: new Float32Array(E), persons: new Float32Array(E), approach: new Float32Array(E), near: new Float32Array(E), nearPersons: new Float32Array(E),
      tramDist: new Float32Array(E).fill(Infinity), busDist: new Float32Array(E).fill(Infinity), count: new Float32Array(E),
    };
    this.edgeSpeedEma = new Float32Array(E);
    for (let e = 0; e < E; e++) this.edgeSpeedEma[e] = net.edgeSpeed[e];
    this.closed = new Uint8Array(E);
    this.frontCache = new Array(E).fill(null);
    this.sumV = new Float32Array(E);
    this.nV = new Int32Array(E);
    this.stopTime = new Float32Array(E);
    this.sigNodeOfEdge = new Uint8Array(E);
    for (let e = 0; e < E; e++) this.sigNodeOfEdge[e] = sig.hasSignal[net.edgeTo[e]];
    this.pedBlock = this.pedBlock;
  }

  get vehicles(): readonly Vehicle[] {
    return this.all;
  }

  // ---------------------------------------------------------------- creation
  makeVehicle(type: number, route: number[], sStart: number, sEnd: number, rng: () => number): Vehicle {
    const v = this.pool.pop() || new Vehicle();
    const p = PARAMS[type];
    v.id = this.nextId++;
    v.type = type;
    v.len = type === VT_TRAM ? 30 : p.len;
    v.a = p.a * (0.85 + 0.3 * rng());
    v.b = p.b;
    v.T = p.T * (0.85 + 0.35 * rng());
    v.s0 = p.s0;
    v.vmax = p.vmax;
    v.maxDecel = p.maxDecel;
    v.commitDecel = p.commitDecel;
    v.v0f = type === VT_BIKE ? 0.75 + 0.25 * rng() : 0.92 + 0.2 * rng();
    v.route = route;
    v.ri = 0;
    v.edge = route[0];
    v.s = sStart;
    v.sEnd = sEnd;
    v.v = 0;
    v.acc = 0;
    v.nextLaneFor = -1;
    v.occN.length = 0; v.occIn.length = 0; v.occOut.length = 0;
    v.wait = 0; v.stopped = 0; v.penalty = 0;
    v.owner = null; v.line = null; v.stopPtr = 0; v.dwell = -1; v.pax = [];
    v.persons = type === VT_CAR ? 1.3 : 1;
    v.schedDelay = 0;
    return v;
  }

  /** Try to insert at the vehicle's current edge/s. Returns false if no room. */
  trySpawn(v: Vehicle, t: number): boolean {
    const e = v.edge;
    if (this.closed[e]) return false;
    const net = this.net;
    if (v.type === VT_BIKE) {
      const list = this.bikes[e];
      if (!this.insertSorted(list, v, 0.8)) return false;
    } else {
      const L = this.lanes[e].length;
      if (L === 0) return false;
      // choose the lane with the most room at s
      let bestLane = -1, bestRoom = -1;
      for (let l = 0; l < L; l++) {
        const room = this.roomAt(this.lanes[e][l], v.s, v.len);
        if (room > bestRoom) { bestRoom = room; bestLane = l; }
      }
      if (bestRoom < 1.5) return false;
      v.lane = bestLane;
      if (!this.insertSorted(this.lanes[e][bestLane], v, 0)) return false;
    }
    void net;
    this.cnt[e]++;
    v.alive = true;
    v.moved = -1;
    v.tSpawn = t;
    this.all.push(v);
    this.vehicleCount++;
    // freeflow estimate
    let ff = 0;
    for (let i = 0; i < v.route.length; i++) {
      const re = v.route[i];
      let l = net.edgeLen[re];
      if (i === 0) l -= v.s;
      if (i === v.route.length - 1) l -= net.edgeLen[re] - v.sEnd;
      const vmax = Math.min(net.edgeSpeed[re], v.type === VT_BIKE ? 5 : v.vmax) * (v.type === VT_BIKE ? 1 : 0.95);
      ff += Math.max(0, l) / Math.max(1, vmax);
    }
    v.freeFlow = ff;
    return true;
  }

  private roomAt(list: Vehicle[], s: number, len: number): number {
    // minimum free distance around position s (front at s, rear at s-len)
    let room = 1e9;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.s >= s) room = Math.min(room, o.s - o.len - s);
      else room = Math.min(room, s - len - o.s);
    }
    return room;
  }

  private insertSorted(list: Vehicle[], v: Vehicle, extra: number): boolean {
    let i = 0;
    while (i < list.length && list[i].s > v.s) i++;
    if (i > 0) {
      const lead = list[i - 1];
      if (lead.s - lead.len - v.s < 1.5 + extra) return false;
    }
    if (i < list.length) {
      const fol = list[i];
      if (v.s - v.len - fol.s < 2.5 + extra) return false;
    }
    list.splice(i, 0, v);
    return true;
  }

  // ---------------------------------------------------------------- stepping
  private stepNo = 0;
  teleports = 0;
  teleportEdges = new Map<number, number>();
  private toTeleport: Vehicle[] = [];
  step(dt: number, t: number) {
    this.stepNo++;
    const net = this.net;
    const st = this.stats;
    st.queue.fill(0); st.persons.fill(0); st.approach.fill(0); st.near.fill(0); st.nearPersons.fill(0);
    st.tramDist.fill(Infinity); st.busDist.fill(Infinity);
    this.frontCache.fill(null);
    this.sumV.fill(0); this.nV.fill(0);
    const active = this.active;
    active.length = 0;
    for (let e = 0; e < net.E; e++) if (this.cnt[e] > 0) active.push(e);
    st.count.fill(0);
    for (let i = 0; i < active.length; i++) st.count[active[i]] = this.cnt[active[i]];

    // pass 1: accelerations
    for (let k = 0; k < active.length; k++) {
      const e = active[k];
      const lanes = this.lanes[e];
      for (let l = 0; l < lanes.length; l++) {
        const list = lanes[l];
        for (let i = 0; i < list.length; i++) this.computeAcc(list[i], i > 0 ? list[i - 1] : null, t, dt);
      }
      const bl = this.bikes[e];
      for (let i = 0; i < bl.length; i++) this.computeAcc(bl[i], i > 0 ? bl[i - 1] : null, t, dt);
    }
    // pass 2: movement
    const arrived: Vehicle[] = [];
    for (let k = 0; k < active.length; k++) {
      const e = active[k];
      const lanes = this.lanes[e];
      for (let l = 0; l < lanes.length; l++) {
        const list = lanes[l];
        for (let i = list.length - 1; i >= 0; i--) {
          const v = list[i];
          if (this.move(v, dt, t)) arrived.push(v);
        }
      }
      const bl = this.bikes[e];
      for (let i = bl.length - 1; i >= 0; i--) {
        if (this.move(bl[i], dt, t)) arrived.push(bl[i]);
      }
    }
    for (const v of arrived) this.remove(v, t);
    if (this.toTeleport.length) {
      for (const v of this.toTeleport) if (v.alive) this.teleport(v, t);
      this.toTeleport.length = 0;
    }
    // bookkeeping of edge speeds
  }

  /** Update smoothed speeds used for congestion-aware routing. Call every few seconds. */
  updateEdgeSpeeds(alpha: number) {
    const net = this.net;
    for (let e = 0; e < net.E; e++) {
      if (this.nV[e] > 0) {
        const mean = this.sumV[e] / this.nV[e];
        this.edgeSpeedEma[e] += alpha * (mean - this.edgeSpeedEma[e]);
      } else if (this.cnt[e] === 0) {
        this.edgeSpeedEma[e] += alpha * 0.5 * (net.edgeSpeed[e] - this.edgeSpeedEma[e]);
      }
    }
  }

  private remove(v: Vehicle, t: number) {
    if (!v.alive) return;
    v.alive = false;
    const e = v.edge;
    if (v.type === VT_BIKE) {
      const i = this.bikes[e].indexOf(v);
      if (i >= 0) this.bikes[e].splice(i, 1);
    } else {
      const lst = this.lanes[e][v.lane];
      const i = lst.indexOf(v);
      if (i >= 0) lst.splice(i, 1);
    }
    this.cnt[e]--;
    this.clearOcc(v);
    const gi = this.all.indexOf(v);
    if (gi >= 0) {
      this.all[gi] = this.all[this.all.length - 1];
      this.all.pop();
    }
    this.vehicleCount--;
    this.hooks.onArrive(v, t);
    this.pool.push(v);
  }


  /** Resolve a long-standing gridlock like SUMO does: jump the vehicle ahead along its route. */
  private teleport(v: Vehicle, t: number) {
    const net = this.net;
    this.teleports++;
    this.teleportEdges.set(v.edge, (this.teleportEdges.get(v.edge) || 0) + 1);
    v.penalty += 600; // a teleport is a failure of the control, not a free pass
    v.stopped = 0;
    v.wait = 0;
    for (let k = 1; k <= 5; k++) {
      const ri = v.ri + k;
      if (ri >= v.route.length) break;
      const e = v.route[ri];
      const s = Math.min(6, net.edgeLen[e] * 0.5);
      let list: Vehicle[];
      let lane = 0;
      if (v.type === VT_BIKE) list = this.bikes[e];
      else {
        const L = this.lanes[e];
        if (!L.length) continue;
        let best = 0, room = -1;
        for (let l = 0; l < L.length; l++) {
          const r = this.roomAt(L[l], s, v.len);
          if (r > room) { room = r; best = l; }
        }
        if (room < 1.0) continue;
        lane = best;
        list = L[best];
      }
      // detach
      const old = v.edge;
      if (v.type === VT_BIKE) { const i = this.bikes[old].indexOf(v); if (i >= 0) this.bikes[old].splice(i, 1); }
      else { const lst = this.lanes[old][v.lane]; const i = lst.indexOf(v); if (i >= 0) lst.splice(i, 1); }
      this.cnt[old]--;
      this.clearOcc(v);
      v.ri = ri;
      v.edge = e;
      v.s = s;
      v.lane = lane;
      v.v = 0;
      v.nextLaneFor = -1;
      let i = 0;
      while (i < list.length && list[i].s > v.s) i++;
      list.splice(i, 0, v);
      this.cnt[e]++;
      return;
    }
    // nowhere to go: finish the trip here
    this.remove(v, t);
  }

  private clearOcc(v: Vehicle) {
    for (let i = v.occN.length - 1; i >= 0; i--) this.dropOcc(v, i);
  }

  private dropOcc(v: Vehicle, i: number) {
    const n = v.occN[i];
    const ov = this.occV[n];
    const k = ov.indexOf(v);
    if (k >= 0) {
      ov.splice(k, 1);
      this.occIn[n].splice(k, 1);
      this.occOut[n].splice(k, 1);
    }
    v.occN.splice(i, 1);
    v.occIn.splice(i, 1);
    v.occOut.splice(i, 1);
  }

  frontLane(e: number): Vehicle | null {
    return this.frontOf(e);
  }

  private frontOf(e: number): Vehicle | null {
    let f = this.frontCache[e];
    if (f !== null) return f;
    const lanes = this.lanes[e];
    let best: Vehicle | null = null;
    for (let l = 0; l < lanes.length; l++) {
      const h = lanes[l][0];
      if (h && (!best || h.s > best.s)) best = h;
    }
    this.frontCache[e] = best;
    return best;
  }

  private pickLane(v: Vehicle, next: number): number {
    if (v.nextLaneFor === next) return v.nextLane;
    const lanes = this.lanes[next];
    let bestLane = 0, bestScore = -1e9;
    const pref = Math.min(v.lane, lanes.length - 1);
    for (let l = 0; l < lanes.length; l++) {
      const list = lanes[l];
      const last = list.length ? list[list.length - 1] : null;
      const rear = last ? last.s - last.len : 1e4;
      // prefer a free lane, slight stickiness to current lane index
      let sc = Math.min(rear, 60) - (l === pref ? 0 : 4) + Math.random() * 0.5;
      if (this.closed[next]) sc = -1e9;
      if (sc > bestScore) { bestScore = sc; bestLane = l; }
    }
    v.nextLane = bestLane;
    v.nextLaneFor = next;
    return bestLane;
  }

  private interactTerm(v: Vehicle, gap: number, vl: number): number {
    const dv = v.v - vl;
    let sStar = v.s0 + v.v * v.T + (v.v * dv) / (2 * Math.sqrt(v.a * v.b));
    if (sStar < v.s0) sStar = v.s0;
    const g = gap < 0.2 ? 0.2 : gap;
    const r = sStar / g;
    return -v.a * r * r;
  }

  private computeAcc(v: Vehicle, leader: Vehicle | null, t: number, dt: number) {
    const net = this.net;
    const e = v.edge;
    const len = net.edgeLen[e];
    const isBike = v.type === VT_BIKE;

    if (v.dwell >= 0) {
      v.acc = v.v > 0 ? -v.maxDecel : 0;
      return;
    }
    let v0 = Math.min(net.edgeSpeed[e] * this.speedScale, v.vmax) * v.v0f;
    if (isBike) v0 = Math.min(v0, 6.2 * v.v0f);
    if (v0 < 1) v0 = 1;
    let inter = 0;
    if (leader) {
      const gap = leader.s - leader.len - v.s;
      const term = this.interactTerm(v, gap, leader.v);
      if (term < inter) inter = term;
    }
    const look = Math.min(160, Math.max(45, (v.v * v.v) / (2 * v.b) + v.v * 2.5 + 25));
    let dist = len - v.s;
    let j = v.ri;
    let edge = e;
    const route = v.route;
    const n = route.length;
    let vt = v0; // upper speed bound from turns
    for (let guard = 0; guard < 8; guard++) {
      // public transport stop on this edge?
      if (v.line && v.stopPtr < v.line.stops.length) {
        const sp = v.line.stops[v.stopPtr];
        if (sp.routeIdx === j) {
          const d = dist - len_(net, edge) + sp.s;
          if (d > -2) {
            const term = this.interactTerm(v, d + v.s0 - 0.5, 0);
            if (term < inter) inter = term;
          }
        }
      }
      if (j >= n - 1) {
        if (j === n - 1 && v.line) {
          // terminus handled via stop
        }
        break;
      }
      const next = route[j + 1];
      const node = net.edgeTo[edge];
      const stopLine = dist - net.stopOff[edge];
      if (stopLine >= -0.5) {
        const ok = this.canEnter(v, node, edge, next, stopLine, isBike);
        if (!ok) {
          const need = (v.v * v.v) / (2 * Math.max(0.3, stopLine));
          if (need <= v.commitDecel || stopLine > 12) {
            const term = this.interactTerm(v, stopLine + 0.2, 0);
            if (term < inter) inter = term;
          }
        }
        // turn speed limit (bounds approach speed by braking distance)
        const ang = Math.abs(net.turnAngle(edge, next));
        if (ang > 0.5) {
          const turnV = ang > 2.4 ? 3 : ang > 1.2 ? 4.8 : 6.5;
          const allowed = Math.sqrt(turnV * turnV + 2 * 2.2 * Math.max(0, stopLine));
          if (allowed < vt) vt = allowed;
        }
      }
      // vehicle ahead on the next edge
      if (!this.closed[next] || true) {
        if (isBike) {
          const bl = this.bikes[next];
          if (bl.length) {
            const last = bl[bl.length - 1];
            const term = this.interactTerm(v, dist + last.s - last.len, last.v);
            if (term < inter) inter = term;
          }
        } else {
          const lanes = this.lanes[next];
          if (lanes.length) {
            const ln = j === v.ri ? this.pickLane(v, next) : Math.min(v.lane, lanes.length - 1);
            const list = lanes[ln];
            if (list.length) {
              const last = list[list.length - 1];
              const term = this.interactTerm(v, dist + last.s - last.len, last.v);
              if (term < inter) inter = term;
            }
          }
        }
      }
      dist += net.edgeLen[next];
      edge = next;
      j++;
      if (dist > look) break;
    }
    if (j === n - 1 || (j >= n - 1)) {
      // approaching destination at sEnd: no braking needed except PT handled above
    }
    // limit by turn speed
    const v0e = Math.min(v0, vt);
    const r = v.v / v0e;
    const free = v.a * (1 - r * r * r * r);
    let acc = free + inter;
    if (acc < -v.maxDecel) acc = -v.maxDecel;
    v.acc = acc;
    void t; void dt;
  }

  private priorityOf(inE: number, outE: number): number {
    const net = this.net;
    if (net.edgeMode[inE] === M_TRAM) return 5;
    const ring = (net.edgeFlags[inE] & F_ROUNDABOUT) !== 0;
    if (ring) return 4;
    if (net.edgeFlags[outE] & F_ROUNDABOUT) return 0;
    const c = net.edgeCls[inE];
    return c >= 3 ? c : 1;
  }

  private turnRank(inE: number, outE: number): number {
    const net = this.net;
    if (net.edgeMode[inE] === M_TRAM) return 3;
    const tt = net.turnType(inE, outE);
    return tt === TURN_THROUGH ? 2 : tt === TURN_RIGHT ? 1 : 0;
  }

  private canEnter(v: Vehicle, node: number, inE: number, outE: number, stopLine: number, isBike: boolean): boolean {
    const net = this.net;
    const sig = this.sig;
    const signalled = sig.hasSignal[node] === 1;
    if (signalled && net.edgeMode[inE] !== 2) {
      if (sig.status[inE] !== 1){ this.why = 1; return false; }
    }
    if (this.closed[outE]){ this.why = 2; return false; }
    if ((net.edgeFlags[outE] & F_ROUNDABOUT) && !(net.edgeFlags[inE] & F_ROUNDABOUT) && v.wait < 60) {
      // do not feed a ring that is already dense: keeps roundabouts from locking up
      const cap = Math.max(1, Math.floor(net.edgeLen[outE] / 9));
      if (this.cnt[outE] >= cap) { this.why = 9; return false; }
    }
    if (this.pedBlock[inE * 2] > 0 || this.pedBlock[outE * 2 + 1] > 0){ this.why = 3; return false; }
    if (net.nodeCross[node] === 2 && this.pedWaitCount[node] > 0 && !signalled){ this.why = 4; return false; }
    // box occupants
    const desperate = v.wait > 40; // deadlock breaker: accept overlap after a long wait
    const ov = this.occV[node];
    if (ov.length && !desperate) {
      const oi = this.occIn[node], oo = this.occOut[node];
      for (let i = 0; i < ov.length; i++) {
        if (ov[i] !== v && net.conflict(inE, outE, oi[i], oo[i])){ this.why = 5; return false; }
      }
    }
    // room beyond
    if (desperate) {
      // skip
    } else if (!isBike) {
      const lanes = this.lanes[outE];
      if (lanes.length) {
        const ln = this.pickLane(v, outE);
        const list = lanes[ln];
        if (list.length) {
          const last = list[list.length - 1];
          const need = Math.min(v.len, 9) + 1.5;
          if (last.s - last.len < need && last.v < 3){ this.why = 6; return false; }
        }
      }
    } else {
      const bl = this.bikes[outE];
      if (bl.length) {
        const last = bl[bl.length - 1];
        if (last.s - last.len < 3 && last.v < 1.5){ this.why = 7; return false; }
      }
    }
    // approaching flows with priority
    const ins = net.inAll[node];
    if (ins.length > 1) {
      for (let k = 0; k < ins.length; k++) {
        const ie = ins[k];
        if (ie === inE) continue;
        if (signalled && sig.status[ie] !== 1) continue;
        const w = this.frontOf(ie);
        if (!w || w === v) continue;
        const dW = net.edgeLen[ie] - w.s - net.stopOff[ie];
        if (dW > 60) continue;
        if (dW > 2.5) {
          if (w.v < 0.5) continue;
          if (dW / w.v > 3.6) continue;
        }
        const wn = w.route[w.ri + 1];
        if (wn === undefined) continue;
        if (!net.conflict(inE, outE, ie, wn)) continue;
        if (v.wait < 70 && this.wins(net, node, ie, wn, w, inE, outE, v, signalled)){ this.why = 8; return false; }
      }
    }
    void stopLine;
    return true;
  }

  private wins(net: Network, node: number, ie: number, wn: number, w: Vehicle, inE: number, outE: number, v: Vehicle, signalled: boolean): boolean {
    if (signalled) {
      const tw = this.turnRank(ie, wn), tv = this.turnRank(inE, outE);
      if (tw !== tv) return tw > tv;
      if (Math.abs(w.wait - v.wait) > 0.5) return w.wait > v.wait;
      return w.id < v.id;
    }
    const pw = this.priorityOf(ie, wn), pv = this.priorityOf(inE, outE);
    if (pw !== pv) return pw > pv;
    const hv = net.headingEnd(inE), hw = net.headingEnd(ie);
    let d = hw - hv;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) > 2.5) {
      // oncoming: left turner yields
      const tw = net.turnType(ie, wn), tv = net.turnType(inE, outE);
      if (tv === TURN_LEFT && tw !== TURN_LEFT) return true;
      if (tw === TURN_LEFT && tv !== TURN_LEFT) return false;
    }
    const sn = Math.sin(d);
    if (sn > 0.35) return true;
    if (sn < -0.35) return false;
    if (Math.abs(w.wait - v.wait) > 0.5) return w.wait > v.wait;
    return w.id < v.id;
  }

  /** advance one vehicle; returns true if it has reached its destination */
  private move(v: Vehicle, dt: number, t: number): boolean {
    if (v.moved === this.stepNo) return false;
    v.moved = this.stepNo;
    const net = this.net;
    let nv = v.v + v.acc * dt;
    if (nv < 0) nv = 0;
    let ds = ((v.v + nv) * 0.5) * dt;
    v.v = nv;
    if (v.dwell >= 0) ds = 0;

    // stats
    const e0 = v.edge;
    this.sumV[e0] += v.v;
    this.nV[e0]++;
    const ln = net.edgeLen[e0];
    const toLine = ln - net.stopOff[e0] - v.s;
    if (v.v < 0.3) {
      v.stopped += dt;
      this.stopTime[e0] += dt;
      this.totalStopSeconds += dt;
    } else v.stopped = 0;
    if (v.stopped > (v.line ? 900 : 300) && v.dwell < 0) this.toTeleport.push(v);
    if (toLine < 15 && v.v < 0.5) v.wait += dt;
    else if (v.v > 2) v.wait = 0;
    if (this.sigNodeOfEdge[e0] === 1 && toLine > -2) {
      const st = this.stats;
      if (v.type === VT_TRAM) {
        if (toLine < st.tramDist[e0]) st.tramDist[e0] = Math.max(0, toLine);
      } else {
        if (v.type === VT_BUS && toLine < st.busDist[e0]) st.busDist[e0] = Math.max(0, toLine);
        if (toLine < 75) {
          const wgt = v.type === VT_BIKE ? 0.3 : v.type === VT_BUS ? 2 : 1;
          st.near[e0] += wgt;
          st.nearPersons[e0] += v.type === VT_BUS ? 1 + v.pax.length : v.type === VT_BIKE ? 1 : v.persons;
        }
        if (toLine < 100) {
          if (v.v < 1.5) {
            st.queue[e0] += v.type === VT_BIKE ? 0.3 : v.type === VT_BUS ? 2 : 1;
            st.persons[e0] += v.type === VT_BUS ? 1 + v.pax.length : v.type === VT_BIKE ? 1 : v.persons;
          } else if (toLine < 45) st.approach[e0] += v.type === VT_BIKE ? 0.3 : 1;
        }
      }
    }

    const prevS = v.s;
    v.s += ds;

    // public transport stopping
    if (v.line && v.dwell < 0 && v.stopPtr < v.line.stops.length) {
      const sp = v.line.stops[v.stopPtr];
      if (sp.routeIdx === v.ri && v.v < 0.25 && sp.s - v.s < 2.5 && sp.s - v.s > -3) {
        v.dwell = Math.max(5, this.hooks.onDwell(v, v.stopPtr, t));
        v.v = 0;
      }
    }
    if (v.dwell >= 0) {
      v.dwell -= dt;
      if (v.dwell < 0 && v.dwell > -1e8) {
        const idx = v.stopPtr;
        v.stopPtr++;
        this.hooks.onDwellEnd(v, idx, t);
        v.dwell = -1;
        if (v.stopPtr >= v.line.stops.length) return true; // terminus reached
      } else return false;
    }

    // register entering the node at the stop line
    this.checkStopLine(v, prevS);

    // edge transitions
    let guard = 0;
    while (v.s >= net.edgeLen[v.edge] && v.ri < v.route.length - 1 && guard++ < 4) {
      const old = v.edge;
      const len = net.edgeLen[old];
      const next = v.route[v.ri + 1];
      // remove from old
      if (v.type === VT_BIKE) {
        this.bikes[old].shift();
      } else {
        const lst = this.lanes[old][v.lane];
        if (!lst) throw new Error(`bad lane type=${v.type} edge=${old} lane=${v.lane} lanes=${this.lanes[old].length} mode=${this.net.edgeMode[old]} nl=${this.net.edgeLanes[old]} ri=${v.ri} line=${!!v.line}`);
        if (lst[0] === v) lst.shift();
        else { const i = lst.indexOf(v); if (i >= 0) lst.splice(i, 1); }
      }
      this.cnt[old]--;
      v.s -= len;
      v.ri++;
      v.edge = next;
      if (v.type === VT_BIKE) this.bikes[next].push(v);
      else {
        const lanes = this.lanes[next];
        const ln2 = v.nextLaneFor === next ? v.nextLane : this.pickLane(v, next);
        v.lane = Math.min(ln2, lanes.length - 1);
        lanes[v.lane].push(v);
      }
      this.cnt[next]++;
      v.nextLaneFor = -1;
      // short edges: register stop-line crossing on the new edge
      this.checkStopLine(v, -1);
    }
    // clear node occupancy once the rear has left the box
    for (let i = v.occN.length - 1; i >= 0; i--) {
      const outE = v.occOut[i];
      const inE = v.occIn[i];
      if (v.edge === outE) {
        if (v.s - v.len > net.stopOff[inE] + 1) this.dropOcc(v, i);
      } else if (v.edge !== inE) {
        this.dropOcc(v, i);
      }
    }
    // arrival
    if (v.ri === v.route.length - 1) {
      if (v.line) {
        if (v.s >= net.edgeLen[v.edge] - 0.1 && v.stopPtr >= v.line.stops.length) return true;
      } else if (v.s >= v.sEnd) return true;
    }
    if (v.s > net.edgeLen[v.edge] + 5 && v.ri === v.route.length - 1) return true;
    return false;
  }

  private checkStopLine(v: Vehicle, prevS: number) {
    const net = this.net;
    if (v.ri >= v.route.length - 1) return;
    const e = v.edge;
    const line = net.edgeLen[e] - net.stopOff[e];
    if (v.s >= line && (prevS < line || prevS < 0)) {
      const node = net.edgeTo[e];
      const next = v.route[v.ri + 1];
      // avoid duplicates
      for (let i = 0; i < v.occN.length; i++) if (v.occN[i] === node && v.occIn[i] === e) return;
      v.occN.push(node); v.occIn.push(e); v.occOut.push(next);
      this.occV[node].push(v);
      this.occIn[node].push(e);
      this.occOut[node].push(next);
    }
  }

  // ---------------------------------------------------------------- rendering support
  pose(v: Vehicle, out: { x: number; y: number; h: number }) {
    const net = this.net;
    let e = v.edge;
    let sc = v.s - v.len * 0.5;
    if (sc < 0 && v.ri > 0) {
      e = v.route[v.ri - 1];
      sc += net.edgeLen[e];
      if (sc < 0) sc = 0;
    }
    const lanesW = 3.2;
    let lat = 0;
    if (v.type === VT_BIKE) lat = net.edgeLanes[e] > 0 ? (net.edgeRev[e] >= 0 ? net.edgeLanes[e] * lanesW + 0.9 : (net.edgeLanes[e] * lanesW) / 2 + 0.9) : 0.8;
    else if (v.type === VT_TRAM) lat = net.edgeRev[e] >= 0 ? 0.9 : 0;
    else {
      const L = net.edgeLanes[e];
      const lane = Math.min(v.lane, Math.max(0, L - 1));
      lat = net.edgeRev[e] >= 0 ? (lane + 0.5) * lanesW : (lane + 0.5 - L / 2) * lanesW;
    }
    net.pointAt(e, sc, lat, out);
  }
}

function len_(net: Network, e: number) {
  return net.edgeLen[e];
}

export { tmpPt };
