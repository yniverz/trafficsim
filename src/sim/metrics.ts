import { MODE_NAMES } from './agents';

export interface ModeStat {
  n: number;
  time: number; // sum of travel times (s)
  delay: number; // sum of delay vs free flow (s)
  dist: number;
  maxDelay: number;
  delays: number[];
}

export interface SeriesPoint {
  t: number;
  vehicles: number;
  meanSpeed: number; // m/s of moving+stopped cars
  stopped: number; // fraction of vehicles standing still
  peds: number;
  pedWaiting: number;
  ptDelay: number; // mean PT delay so far in the last window (s)
  carDelay: number; // mean car delay of trips completed in window
}

function pct(a: number[], q: number): number {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(q * b.length))];
}

export class Metrics {
  modes: ModeStat[] = MODE_NAMES.map(() => ({ n: 0, time: 0, delay: 0, dist: 0, maxDelay: 0, delays: [] }));
  spawnWait = 0; // total seconds vehicles waited to enter the network
  spawnWaitN = 0;
  pedWaits = 0;
  pedWaitSum = 0;
  pedWaitMax = 0;
  ptStopArrivals = 0;
  ptDelaySum = 0; // sum of positive delay
  ptLate3 = 0; // arrivals more than 3 min late
  ptLateTram = 0;
  ptArrTram = 0;
  ptDelaySumTram = 0;
  ptLateBus = 0;
  ptArrBus = 0;
  ptDelaySumBus = 0;
  boardings = 0;
  teleports = 0;
  stranded = 0; // trips that could not be dispatched
  series: SeriesPoint[] = [];
  // sliding window accumulators
  winCarDelay = 0;
  winCarN = 0;
  winPtDelay = 0;
  winPtN = 0;
  pedWaitByNode = new Map<number, { n: number; sum: number }>();

  tripDone(mode: number, time: number, delay: number, dist: number) {
    const m = this.modes[mode];
    m.n++;
    m.time += time;
    const d = Math.max(0, delay);
    m.delay += d;
    m.dist += dist;
    if (d > m.maxDelay) m.maxDelay = d;
    m.delays.push(d);
    if (mode === 2) { this.winCarDelay += d; this.winCarN++; }
  }

  pedWait(w: number, node: number) {
    this.pedWaits++;
    this.pedWaitSum += w;
    if (w > this.pedWaitMax) this.pedWaitMax = w;
    let r = this.pedWaitByNode.get(node);
    if (!r) this.pedWaitByNode.set(node, (r = { n: 0, sum: 0 }));
    r.n++;
    r.sum += w;
  }

  ptArrival(mode: 'tram' | 'bus', delay: number) {
    const d = Math.max(0, delay);
    this.ptStopArrivals++;
    this.ptDelaySum += d;
    if (d > 180) this.ptLate3++;
    if (mode === 'tram') {
      this.ptArrTram++; this.ptDelaySumTram += d; if (d > 180) this.ptLateTram++;
    } else {
      this.ptArrBus++; this.ptDelaySumBus += d; if (d > 180) this.ptLateBus++;
    }
    this.winPtDelay += d;
    this.winPtN++;
  }

  /** Total person-hours of delay across modes + pedestrian waiting. */
  personHoursLost(): number {
    let s = 0;
    for (const m of this.modes) s += m.delay;
    return s / 3600;
  }

  push(p: SeriesPoint) {
    p.ptDelay = this.winPtN ? this.winPtDelay / this.winPtN : 0;
    p.carDelay = this.winCarN ? this.winCarDelay / this.winCarN : 0;
    this.winPtDelay = this.winPtN = this.winCarDelay = this.winCarN = 0;
    this.series.push(p);
  }

  summary() {
    const m = this.modes;
    const avg = (x: ModeStat, k: 'time' | 'delay') => (x.n ? x[k] / x.n : 0);
    return {
      trips: m.map((x, i) => ({
        mode: MODE_NAMES[i], n: x.n, avgTime: avg(x, 'time'), avgDelay: avg(x, 'delay'), maxDelay: x.maxDelay,
        p90Delay: pct(x.delays, 0.9), p99Delay: pct(x.delays, 0.99),
      })),
      spawnWaitAvg: this.spawnWaitN ? this.spawnWait / this.spawnWaitN : 0,
      pedWaitAvg: this.pedWaits ? this.pedWaitSum / this.pedWaits : 0,
      pedWaitMax: this.pedWaitMax,
      pedWaits: this.pedWaits,
      ptDelayAvg: this.ptStopArrivals ? this.ptDelaySum / this.ptStopArrivals : 0,
      ptLateShare: this.ptStopArrivals ? this.ptLate3 / this.ptStopArrivals : 0,
      tramDelayAvg: this.ptArrTram ? this.ptDelaySumTram / this.ptArrTram : 0,
      tramLateShare: this.ptArrTram ? this.ptLateTram / this.ptArrTram : 0,
      busDelayAvg: this.ptArrBus ? this.ptDelaySumBus / this.ptArrBus : 0,
      busLateShare: this.ptArrBus ? this.ptLateBus / this.ptArrBus : 0,
      personHoursLost: this.personHoursLost(),
      boardings: this.boardings,
      stranded: this.stranded,
      teleports: this.teleports,
    };
  }
}
