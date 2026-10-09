import {
  F_BIKE, F_CAR, F_ONEWAY, F_ROUNDABOUT, F_WALK, F_TUNNEL,
  type NetworkData,
} from './types';
import { Router, type GraphView } from './routing';

export const M_ROAD = 0;
export const M_TRAM = 1;
export const M_WALK = 2;

export const LANE_W = 3.2;

export interface Arm {
  key: number; // canonical edge id
  angle: number; // direction away from node
  pedIdx: number[]; // indices into pedBlock array
  inEdges: number[]; // vehicle edges ending at this node on this arm
  outEdges: number[];
  width: number; // crossing width in metres
}

/** Movement type classification */
export const TURN_LEFT = 0;
export const TURN_RIGHT = 1;
export const TURN_THROUGH = 2;

export class Network {
  N: number;
  E: number;
  nodeX: Float32Array;
  nodeY: Float32Array;
  nodeSignal: Uint8Array;
  nodeCross: Uint8Array;
  nodeGate: Uint8Array;
  edgeFrom: Int32Array;
  edgeTo: Int32Array;
  edgeLen: Float32Array;
  edgeSpeed: Float32Array;
  edgeLanes: Uint8Array;
  edgeCls: Uint8Array;
  edgeFlags: Uint16Array;
  edgeMode: Uint8Array;
  edgeRev: Int32Array;
  edgePts: Float32Array[];
  edgeCum: Float32Array[];
  stopOff: Float32Array; // distance before the node centre where the stop line sits
  outCar: number[][];
  inCar: number[][];
  outBike: number[][];
  outTram: number[][];
  inTram: number[][];
  inAll: number[][]; // vehicle-ish edges (road car, bike-only, tram) ending at node
  // walking graph: arcs 2*c+d
  walkCanon: number[] = []; // canonical walkable edge ids
  arcFrom: Int32Array;
  arcTo: Int32Array;
  arcLen: Float32Array;
  walkOut: number[][];
  arcOfEdge: Map<number, number> = new Map();
  nodeArms: Arm[][];
  carRouter: Router;
  bikeRouter: Router;
  tramRouter: Router;
  walkRouter: Router;
  carGraph: GraphView;
  grid = new Map<number, number[]>();
  readonly CELL = 80;
  private moveCache = new Map<number, number>();

  constructor(public data: NetworkData) {
    const nodes = data.nodes;
    const edges = data.edges;
    this.N = nodes.length;
    this.E = edges.length;
    this.nodeX = new Float32Array(this.N);
    this.nodeY = new Float32Array(this.N);
    this.nodeSignal = new Uint8Array(this.N);
    this.nodeCross = new Uint8Array(this.N);
    this.nodeGate = new Uint8Array(this.N);
    nodes.forEach((n, i) => {
      this.nodeX[i] = n.x;
      this.nodeY[i] = n.y;
      this.nodeSignal[i] = n.signal || n.cross === 3 ? 1 : 0;
      this.nodeCross[i] = n.cross;
      this.nodeGate[i] = n.gate;
    });
    const E = this.E;
    this.edgeFrom = new Int32Array(E);
    this.edgeTo = new Int32Array(E);
    this.edgeLen = new Float32Array(E);
    this.edgeSpeed = new Float32Array(E);
    this.edgeLanes = new Uint8Array(E);
    this.edgeCls = new Uint8Array(E);
    this.edgeFlags = new Uint16Array(E);
    this.edgeMode = new Uint8Array(E);
    this.edgeRev = new Int32Array(E);
    this.edgePts = [];
    this.edgeCum = [];
    this.stopOff = new Float32Array(E);
    this.outCar = nodes.map(() => []);
    this.inCar = nodes.map(() => []);
    this.outBike = nodes.map(() => []);
    this.outTram = nodes.map(() => []);
    this.inTram = nodes.map(() => []);
    this.inAll = nodes.map(() => []);
    edges.forEach((e, i) => {
      this.edgeFrom[i] = e.from;
      this.edgeTo[i] = e.to;
      this.edgeSpeed[i] = e.speed;
      this.edgeLanes[i] = e.lanes;
      this.edgeCls[i] = e.cls;
      this.edgeFlags[i] = e.flags;
      this.edgeMode[i] = e.mode === 'road' ? M_ROAD : e.mode === 'tram' ? M_TRAM : M_WALK;
      this.edgeRev[i] = e.rev;
      const pts = new Float32Array(e.pts);
      this.edgePts.push(pts);
      const cum = new Float32Array(pts.length / 2);
      for (let k = 1; k < cum.length; k++) cum[k] = cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
      this.edgeCum.push(cum);
      this.edgeLen[i] = cum[cum.length - 1];
      if (e.mode === 'road') {
        if (e.lanes > 0 && e.flags & F_CAR) {
          this.outCar[e.from].push(i);
          this.inCar[e.to].push(i);
          this.inAll[e.to].push(i);
        } else if (e.flags & F_BIKE) {
          this.inAll[e.to].push(i);
        }
        if (e.flags & F_BIKE) this.outBike[e.from].push(i);
      } else if (e.mode === 'tram') {
        this.outTram[e.from].push(i);
        this.inTram[e.to].push(i);
        this.inAll[e.to].push(i);
      }
    });
    this.computeStopOffsets();

    // walking arcs
    const seen = new Set<number>();
    const walkCanonList: number[] = [];
    edges.forEach((e, i) => {
      const walkable = e.mode === 'walk' || (e.mode === 'road' && e.flags & F_WALK);
      if (!walkable) return;
      const c = e.rev >= 0 ? Math.min(i, e.rev) : i;
      if (seen.has(c)) return;
      seen.add(c);
      walkCanonList.push(c);
    });
    this.walkCanon = walkCanonList;
    const A = walkCanonList.length * 2;
    this.arcFrom = new Int32Array(A);
    this.arcTo = new Int32Array(A);
    this.arcLen = new Float32Array(A);
    this.walkOut = nodes.map(() => []);
    walkCanonList.forEach((c, k) => {
      this.arcOfEdge.set(c, k);
      this.arcFrom[2 * k] = this.edgeFrom[c];
      this.arcTo[2 * k] = this.edgeTo[c];
      this.arcFrom[2 * k + 1] = this.edgeTo[c];
      this.arcTo[2 * k + 1] = this.edgeFrom[c];
      this.arcLen[2 * k] = this.arcLen[2 * k + 1] = this.edgeLen[c];
      this.walkOut[this.edgeFrom[c]].push(2 * k);
      this.walkOut[this.edgeTo[c]].push(2 * k + 1);
    });

    this.carGraph = this.graph(this.outCar);
    this.carRouter = new Router(this.carGraph, 36);
    this.bikeRouter = new Router(this.graph(this.outBike), 8);
    this.tramRouter = new Router(this.graph(this.outTram), 17);
    this.walkRouter = new Router({ nodeCount: this.N, nodeX: this.nodeX, nodeY: this.nodeY, edgeFrom: this.arcFrom, edgeTo: this.arcTo, out: this.walkOut }, 1.5);

    this.nodeArms = this.buildArms();
    this.buildGrid();
  }

  private graph(out: number[][]): GraphView {
    return { nodeCount: this.N, nodeX: this.nodeX, nodeY: this.nodeY, edgeFrom: this.edgeFrom, edgeTo: this.edgeTo, out };
  }

  private computeStopOffsets() {
    const R = new Float32Array(this.N);
    for (let e = 0; e < this.E; e++) {
      if (this.edgeMode[e] === M_WALK) continue;
      const lanes = Math.max(1, this.edgeLanes[e]);
      const w = (lanes + (this.edgeRev[e] >= 0 ? lanes : 0)) * LANE_W * 0.5;
      for (const n of [this.edgeFrom[e], this.edgeTo[e]]) R[n] = Math.max(R[n], w);
    }
    for (let e = 0; e < this.E; e++) {
      if (this.edgeMode[e] === M_WALK) continue;
      const n = this.edgeTo[e];
      const deg = this.inAll[n].length;
      let off = Math.max(3.5, Math.min(11, R[n] * 0.9 + (deg >= 3 ? 2 : 0) + 1.5));
      off = Math.min(off, this.edgeLen[e] * 0.4);
      this.stopOff[e] = off;
    }
  }

  /** Spatial grid over edges for nearest queries */
  private buildGrid() {
    const C = this.CELL;
    for (let e = 0; e < this.E; e++) {
      const p = this.edgePts[e];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
      }
      for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++)
        for (let cy = Math.floor(y0 / C); cy <= Math.floor(y1 / C); cy++) {
          const k = cx * 100003 + cy;
          let a = this.grid.get(k);
          if (!a) this.grid.set(k, (a = []));
          a.push(e);
        }
    }
  }

  nearestEdge(x: number, y: number, pred: (e: number) => boolean, maxD = 150): { edge: number; s: number; d: number } | null {
    const C = this.CELL;
    let best = null as { edge: number; s: number; d: number } | null;
    const cx = Math.floor(x / C), cy = Math.floor(y / C);
    const seen = new Set<number>();
    for (let r = 0; r <= Math.ceil(maxD / C) + 0; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const list = this.grid.get((cx + dx) * 100003 + (cy + dy));
          if (!list) continue;
          for (const e of list) {
            if (seen.has(e)) continue;
            seen.add(e);
            if (!pred(e)) continue;
            const pr = this.project(e, x, y);
            if (pr.d < maxD && (!best || pr.d < best.d)) best = { edge: e, s: pr.s, d: pr.d };
          }
        }
      if (best && best.d <= r * C) break;
    }
    return best;
  }

  project(e: number, x: number, y: number): { s: number; d: number } {
    const p = this.edgePts[e];
    const cum = this.edgeCum[e];
    let bd = Infinity, bs = 0;
    for (let k = 1; k < cum.length; k++) {
      const ax = p[2 * k - 2], ay = p[2 * k - 1];
      const dx = p[2 * k] - ax, dy = p[2 * k + 1] - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (d < bd) { bd = d; bs = cum[k - 1] + t * (cum[k] - cum[k - 1]); }
    }
    return { s: bs, d: bd };
  }

  /** Position and heading at distance s along edge e, offset `lat` metres to the right. */
  pointAt(e: number, s: number, lat: number, out: { x: number; y: number; h: number }) {
    const p = this.edgePts[e];
    const cum = this.edgeCum[e];
    const n = cum.length;
    if (s < 0) s = 0;
    const len = cum[n - 1];
    let k = 1;
    if (s >= len) k = n - 1;
    else {
      // binary search
      let lo = 1, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < s) lo = mid + 1; else hi = mid;
      }
      k = lo;
    }
    const sl = cum[k] - cum[k - 1];
    const t = sl > 0 ? (s - cum[k - 1]) / sl : 0;
    const ax = p[2 * k - 2], ay = p[2 * k - 1], bx = p[2 * k], by = p[2 * k + 1];
    const dx = bx - ax, dy = by - ay;
    const dl = Math.hypot(dx, dy) || 1;
    const ux = dx / dl, uy = dy / dl;
    out.x = ax + dx * t + uy * lat;
    out.y = ay + dy * t - ux * lat;
    out.h = Math.atan2(dy, dx);
  }

  /** heading of edge at its end (direction of travel when entering `to` node) */
  headingEnd(e: number): number {
    const p = this.edgePts[e];
    const n = p.length;
    let k = n - 2;
    // use points at least 3 m from end
    while (k >= 2 && Math.hypot(p[n - 2] - p[k - 2], p[n - 1] - p[k - 1]) < 3) k -= 2;
    return Math.atan2(p[n - 1] - p[k - 1], p[n - 2] - p[k - 2]);
  }
  headingStart(e: number): number {
    const p = this.edgePts;
    const q = p[e];
    let k = 2;
    while (k < q.length - 2 && Math.hypot(q[k] - q[0], q[k + 1] - q[1]) < 3) k += 2;
    return Math.atan2(q[k + 1] - q[1], q[k] - q[0]);
  }

  private buildArms(): Arm[][] {
    const arms: Arm[][] = this.data.nodes.map(() => []);
    // gather incident vehicle edges per node
    const byNode: Map<number, Map<number, Arm>> = new Map();
    const add = (n: number, e: number, isIn: boolean) => {
      const key = this.edgeRev[e] >= 0 ? Math.min(e, this.edgeRev[e]) : e;
      let m = byNode.get(n);
      if (!m) byNode.set(n, (m = new Map()));
      let a = m.get(key);
      if (!a) {
        const ang = isIn ? this.headingEnd(e) + Math.PI : this.headingStart(e);
        a = { key, angle: ang, pedIdx: [], inEdges: [], outEdges: [], width: 6 };
        m.set(key, a);
      }
      if (isIn) {
        a.inEdges.push(e);
        a.pedIdx.push(e * 2);
      } else {
        a.outEdges.push(e);
        a.pedIdx.push(e * 2 + 1);
      }
      a.width = Math.max(a.width, (this.edgeLanes[e] * (this.edgeRev[e] >= 0 ? 2 : 1)) * LANE_W + 2.5);
    };
    for (let e = 0; e < this.E; e++) {
      if (this.edgeMode[e] === M_WALK) continue;
      if (this.edgeMode[e] === M_ROAD && this.edgeLanes[e] === 0) continue; // cycleways count as walk arms
      add(this.edgeTo[e], e, true);
      add(this.edgeFrom[e], e, false);
    }
    for (const [n, m] of byNode) arms[n] = [...m.values()];
    return arms;
  }

  // ---------------------------------------------------------------- movements
  turnType(inE: number, outE: number): number {
    let d = this.headingStart(outE) - this.headingEnd(inE);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (d > 0.6) return TURN_LEFT;
    if (d < -0.6) return TURN_RIGHT;
    return TURN_THROUGH;
  }

  turnAngle(inE: number, outE: number): number {
    let d = this.headingStart(outE) - this.headingEnd(inE);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  /** Do movements (a1->b1) and (a2->b2) at the same node cross or merge? */
  conflict(a1: number, b1: number, a2: number, b2: number): boolean {
    if (a1 === a2) return false;
    if (b1 === b2) return true;
    const key = ((a1 * 31 + b1) * 1000003 + (a2 * 31 + b2)) % 4294967291;
    const c = this.moveCache.get(key);
    if (c !== undefined) return c === 1;
    const r = this.geomConflict(a1, b1, a2, b2);
    this.moveCache.set(key, r ? 1 : 0);
    return r;
  }

  private movePath(a: number, b: number): number[] {
    const hi = this.headingEnd(a), ho = this.headingStart(b);
    const off1 = this.edgeMode[a] === M_TRAM ? 0 : 1.7;
    const off2 = this.edgeMode[b] === M_TRAM ? 0 : 1.7;
    const n = this.edgeTo[a];
    const cx = this.nodeX[n], cy = this.nodeY[n];
    const L = 14;
    const rix = Math.sin(hi), riy = -Math.cos(hi);
    const rox = Math.sin(ho), roy = -Math.cos(ho);
    return [
      cx - Math.cos(hi) * L + rix * off1, cy - Math.sin(hi) * L + riy * off1,
      cx + (rix * off1 + rox * off2) * 0.5, cy + (riy * off1 + roy * off2) * 0.5,
      cx + Math.cos(ho) * L + rox * off2, cy + Math.sin(ho) * L + roy * off2,
    ];
  }

  private geomConflict(a1: number, b1: number, a2: number, b2: number): boolean {
    const p = this.movePath(a1, b1);
    const q = this.movePath(a2, b2);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        const ux = p[2 * i + 2] - p[2 * i], uy = p[2 * i + 3] - p[2 * i + 1];
        const vx = q[2 * j + 2] - q[2 * j], vy = q[2 * j + 3] - q[2 * j + 1];
        // near-parallel paths (e.g. opposite directions on the same track) do not conflict
        const sin = Math.abs(ux * vy - uy * vx) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-9);
        if (sin < 0.3) continue;
        if (segCross(p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3], q[2 * j], q[2 * j + 1], q[2 * j + 2], q[2 * j + 3])) return true;
      }
    return false;
  }

  // ---------------------------------------------------------------- walking helpers
  /** Arcs a walker passes: returns arms crossed when moving from arc i to arc j at node n. */
  crossedArms(n: number, arcIn: number, arcOut: number): Arm[] {
    const arms = this.nodeArms[n];
    if (arms.length === 0) return [];
    const cIn = this.walkCanon[arcIn >> 1], cOut = this.walkCanon[arcOut >> 1];
    const isArm = (c: number) => this.edgeMode[c] !== M_WALK && !(this.edgeMode[c] === M_ROAD && this.edgeLanes[c] === 0);
    const armOf = (c: number) => arms.find((a) => a.key === c);
    const aIn = isArm(cIn), aOut = isArm(cOut);
    if (!aIn && !aOut) return arms; // footpath crossing the road
    const angOf = (arc: number) => {
      const c = this.walkCanon[arc >> 1];
      // direction away from node n along this arc's geometry
      return (arc & 1) === 0 ? this.headingStart(c) : this.headingEnd(c) + Math.PI;
    };
    // arc "in" leaves node n in direction opposite of the arrival: arrival arc ends at n so it points away as reverse
    const a1 = angOf(arcIn ^ 1);
    const a2 = angOf(arcOut);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const inKey = aIn ? cIn : -1, outKey = aOut ? cOut : -1;
    const lo = Math.min(0, d), hi = Math.max(0, d);
    const res: Arm[] = [];
    for (const a of arms) {
      if (a.key === inKey || a.key === outKey) continue;
      let r = a.angle - a1;
      while (r > Math.PI) r -= 2 * Math.PI;
      while (r < -Math.PI) r += 2 * Math.PI;
      if (r > lo + 0.05 && r < hi - 0.05) res.push(a);
    }
    void armOf;
    return res;
  }

  edgeName(e: number): string {
    const n = this.data.edges[e].name;
    return n >= 0 ? this.data.names[n] : '';
  }
}

function segCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export { F_ONEWAY, F_ROUNDABOUT, F_TUNNEL, F_WALK, F_CAR, F_BIKE };
