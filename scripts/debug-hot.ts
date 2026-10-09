import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';
const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const sim = new Simulation(data, { demand: { agents: +(process.argv[3] || 50000), seed: 42, startHour: 6.5, endHour: 24 } as any, strategy: (process.argv[2] || 'fixed') as any, startTime: 6.5 * 3600 });
sim.advance(1.5 * 3600);
const net = sim.net, eng = sim.eng;
const idx = [...Array(net.E).keys()].sort((a, b) => eng.stopTime[b] - eng.stopTime[a]).slice(0, 25);
let tot = 0; for (let e = 0; e < net.E; e++) tot += eng.stopTime[e];
console.log('total stop hours', (tot / 3600).toFixed(0));
const kinds: Record<string, number> = {};
for (let e = 0; e < net.E; e++) {
  const n = net.edgeTo[e];
  const k = (net.nodeSignal[n] ? 'signal' : net.outCar[n].length + net.inCar[n].length <= 2 ? 'plain' : 'unsignalised junction') + ' mode' + net.edgeMode[e];
  kinds[k] = (kinds[k] || 0) + eng.stopTime[e];
}
console.log(Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, (v / 3600).toFixed(0) + 'h'])));
for (const e of idx) {
  const n = net.edgeTo[e];
  const lane = eng.lanes[e];
  const head = eng.frontLane(e);
  let why = '-';
  if (head && head.route[head.ri + 1] !== undefined) {
    const ok = (eng as any).canEnter(head, n, e, head.route[head.ri + 1], 1, false);
    why = ok ? 'ok' : 'why' + (eng as any).why;
  }
  console.log(`edge ${e} ${net.edgeName(e).slice(0, 22).padEnd(22)} cls${net.edgeCls[e]} L${net.edgeLanes[e]} len${net.edgeLen[e].toFixed(0).padStart(4)} v${(net.edgeSpeed[e] * 3.6).toFixed(0)} stop ${(eng.stopTime[e] / 3600).toFixed(1)}h node ${n} sig${net.nodeSignal[n]} ins ${net.inAll[n].length} cnt ${eng.cnt[e]} head ${head ? head.v.toFixed(1) : '-'} ${why}`);
}
