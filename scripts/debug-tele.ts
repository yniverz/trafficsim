import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';
const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const sim = new Simulation(data, { demand: { agents: 25000, seed: 42, startHour: 6.5, endHour: 24 } as any, strategy: (process.argv[2] || 'actuated') as any, startTime: 6.5 * 3600 });
sim.advance(3 * 3600);
const net = sim.net;
const rows = [...sim.eng.teleportEdges].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('teleports', sim.eng.teleports);
for (const [e, n] of rows) {
  const to = net.edgeTo[e];
  console.log(`edge ${e} x${n} ${net.edgeName(e)} cls${net.edgeCls[e]} L${net.edgeLanes[e]} len${net.edgeLen[e].toFixed(0)} node ${to} sig${net.nodeSignal[to]} ins${net.inAll[to].length} outs${net.outCar[to].length} pos ${net.nodeX[to].toFixed(0)},${net.nodeY[to].toFixed(0)} roundabout=${(net.edgeFlags[e] & 64) ? 1 : 0}`);
}
