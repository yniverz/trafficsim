import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';
const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const sim = new Simulation(data, { demand: { agents: 25000, seed: 42, startHour: 6.5, endHour: 24 } as any, strategy: 'smart', startTime: 6.5 * 3600 });
sim.advance(75 * 60);
const eng = sim.eng, net = sim.net;
let overlaps = 0, pairs = 0, over = 0, nveh = 0, maxOver = 0;
for (let e = 0; e < net.E; e++) {
  const lanes = eng.lanes[e];
  for (const lane of lanes) {
    for (let i = 1; i < lane.length; i++) {
      pairs++;
      const gap = lane[i - 1].s - lane[i - 1].len - lane[i].s;
      if (gap < -0.5) overlaps++;
    }
  }
}
for (const v of eng.vehicles) {
  nveh++;
  const lim = net.edgeSpeed[v.edge] * 1.35 + 1;
  if (v.v > lim) { over++; maxOver = Math.max(maxOver, v.v - net.edgeSpeed[v.edge]); }
}
console.log({ vehicles: nveh, adjacentPairs: pairs, overlaps, speeding: over, maxOver: maxOver.toFixed(1) });
const pt = sim.peds.peds;
const states = [0, 0, 0, 0, 0]; for (const p of pt) states[p.state]++;
console.log('ped states walk/waitcross/crossing/waitstop/riding', states);
let cumWait = 0, nw = 0; for (const p of pt) if (p.state === 1) { cumWait += sim.t - p.waitingSince; nw++; }
console.log('mean current ped wait', nw ? (cumWait / nw).toFixed(1) : 0);
