// A* shortest path over a directed graph given as adjacency lists.

class MinHeap {
  keys: number[] = [];
  vals: number[] = [];
  size = 0;
  clear() {
    this.size = 0;
  }
  push(k: number, v: number) {
    let i = this.size++;
    this.keys[i] = k;
    this.vals[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = k;
    this.vals[i] = v;
  }
  // returns value, key available in lastKey
  lastKey = 0;
  pop(): number {
    const topV = this.vals[0];
    this.lastKey = this.keys[0];
    this.size--;
    if (this.size > 0) {
      const k = this.keys[this.size];
      const v = this.vals[this.size];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= this.size) break;
        if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
        if (this.keys[c] >= k) break;
        this.keys[i] = this.keys[c];
        this.vals[i] = this.vals[c];
        i = c;
      }
      this.keys[i] = k;
      this.vals[i] = v;
    }
    return topV;
  }
}

export interface GraphView {
  nodeCount: number;
  nodeX: ArrayLike<number>;
  nodeY: ArrayLike<number>;
  edgeFrom: ArrayLike<number>;
  edgeTo: ArrayLike<number>;
  out: number[][]; // node -> outgoing edge ids
}

export class Router {
  private dist: Float64Array;
  private prev: Int32Array;
  private stamp: Int32Array;
  private closed: Int32Array;
  private cur = 0;
  private heap = new MinHeap();
  constructor(private g: GraphView, private vmax: number) {
    this.dist = new Float64Array(g.nodeCount);
    this.prev = new Int32Array(g.nodeCount);
    this.stamp = new Int32Array(g.nodeCount);
    this.closed = new Int32Array(g.nodeCount);
  }

  /**
   * Cheapest edge sequence from node `a` to node `b`.
   * cost(e) must be >= length(e)/vmax (admissible A*). Returning Infinity forbids an edge.
   */
  routeNodes(a: number, b: number, cost: (e: number) => number): number[] | null {
    return this.search(a, (n) => n === b, b, cost);
  }

  /** Multi-target variant: stops at the first node in `targets`. Returns edges and the node reached. */
  routeToAny(a: number, targets: Set<number>, cost: (e: number) => number): { edges: number[]; node: number } | null {
    let reached = -1;
    const r = this.search(a, (n) => {
      if (targets.has(n)) {
        reached = n;
        return true;
      }
      return false;
    }, -1, cost);
    return r ? { edges: r, node: reached } : null;
  }

  /**
   * Dijkstra from several weighted sources to several weighted targets.
   * Returns the edge path and the chosen source/target nodes.
   */
  multi(sources: [number, number][], targets: Map<number, number>, cost: (e: number) => number): { edges: number[]; src: number; dst: number; cost: number } | null {
    const g = this.g;
    this.cur++;
    const cur = this.cur;
    const { dist, prev, stamp, heap, closed } = this;
    heap.clear();
    for (const [n, c] of sources) {
      if (stamp[n] !== cur || c < dist[n]) {
        stamp[n] = cur;
        dist[n] = c;
        prev[n] = -1;
        heap.push(c, n);
      }
    }
    let best = Infinity, bestNode = -1;
    while (heap.size > 0) {
      const n = heap.pop();
      const key = heap.lastKey;
      if (key >= best) break;
      if (closed[n] === cur) continue;
      closed[n] = cur;
      const tc = targets.get(n);
      if (tc !== undefined && dist[n] + tc < best) {
        best = dist[n] + tc;
        bestNode = n;
      }
      const d = dist[n];
      const outs = g.out[n];
      for (let i = 0; i < outs.length; i++) {
        const e = outs[i];
        const c = cost(e);
        if (!isFinite(c)) continue;
        const m = g.edgeTo[e];
        const nd = d + c;
        if (stamp[m] !== cur || nd < dist[m]) {
          stamp[m] = cur;
          dist[m] = nd;
          prev[m] = e;
          heap.push(nd, m);
        }
      }
    }
    if (bestNode < 0) return null;
    const path: number[] = [];
    let c = bestNode;
    while (prev[c] >= 0) {
      const e = prev[c];
      path.push(e);
      c = g.edgeFrom[e];
    }
    path.reverse();
    return { edges: path, src: c, dst: bestNode, cost: best };
  }

  private search(a: number, isGoal: (n: number) => boolean, goalNode: number, cost: (e: number) => number): number[] | null {
    const g = this.g;
    this.cur++;
    const cur = this.cur;
    const { dist, prev, stamp, heap } = this;
    heap.clear();
    dist[a] = 0;
    prev[a] = -1;
    stamp[a] = cur;
    const gx = goalNode >= 0 ? g.nodeX[goalNode] : 0;
    const gy = goalNode >= 0 ? g.nodeY[goalNode] : 0;
    const h = (n: number) => (goalNode >= 0 ? Math.hypot(g.nodeX[n] - gx, g.nodeY[n] - gy) / this.vmax : 0);
    heap.push(h(a), a);
    const closed = this.closed;
    while (heap.size > 0) {
      const n = heap.pop();
      if (closed[n] === cur) continue;
      closed[n] = cur;
      if (isGoal(n)) {
        const path: number[] = [];
        let c = n;
        while (prev[c] >= 0) {
          const e = prev[c];
          path.push(e);
          c = g.edgeFrom[e];
        }
        path.reverse();
        return path;
      }
      const d = dist[n];
      const outs = g.out[n];
      for (let i = 0; i < outs.length; i++) {
        const e = outs[i];
        const c = cost(e);
        if (!isFinite(c)) continue;
        const m = g.edgeTo[e];
        const nd = d + c;
        if (stamp[m] !== cur || nd < dist[m]) {
          stamp[m] = cur;
          dist[m] = nd;
          prev[m] = e;
          heap.push(nd + h(m), m);
        }
      }
    }
    return null;
  }
}
