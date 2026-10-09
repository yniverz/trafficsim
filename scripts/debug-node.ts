import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';
const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const sim = new Simulation(data, { demand: { agents: 25000, seed: 42, startHour: 6.5, endHour: 24 } as any, strategy: (process.argv[2] || 'smart') as any, startTime: 6.5 * 3600 });
const net = sim.net, eng = sim.eng;
const target = +(process.argv[3] || 920);
let found = false;
// run until vehicles have been stopped > 200 s with head at target node
for (let i = 0; i < 4000 && !found; i++) {
  sim.advance(10);
  for (const e of net.inAll[target]) {
    const h = eng.frontLane(e);
    if (h && h.stopped > 200) found = true;
  }
}
console.log('time', (sim.t / 3600).toFixed(2), 'node', target, 'x,y', net.nodeX[target], net.nodeY[target], 'signal', net.nodeSignal[target]);
const c = sim.sig.byNode.get(target);
if (c) console.log('controller phases', c.phases.map((p, i) => `${i}:[${p.edges.join(',')}]${p.pedOnly ? 'ped' : ''}${p.tramOnly ? 'tram' : ''}`).join(' '), 'disp', c.disp, 'sub', c.sub, 't', c.t.toFixed(1));
for (const e of net.inAll[target]) {
  const lanes = eng.lanes[e];
  const h = eng.frontLane(e);
  const nxt = h ? h.route[h.ri + 1] : undefined;
  let why = '-';
  if (h && nxt !== undefined) { const ok = (eng as any).canEnter(h, target, e, nxt, 1, false); why = ok ? 'ok' : 'why' + (eng as any).why; }
  console.log(`in ${e} ${net.edgeName(e)} mode${net.edgeMode[e]} L${lanes.length} len${net.edgeLen[e].toFixed(0)} status ${sim.sig.status[e]} cnt ${eng.cnt[e]} head: ${h ? `s=${h.s.toFixed(0)} v=${h.v.toFixed(1)} stopped=${h.stopped.toFixed(0)} wait=${h.wait.toFixed(0)} -> ${nxt} turn=${nxt !== undefined ? net.turnType(e, nxt) : ''} ${why}` : 'none'}`);
}
console.log('occupants', eng.occV[target].map((o, i) => `veh${o.id} t${o.type} ${eng.occIn[target][i]}>${eng.occOut[target][i]} s=${o.s.toFixed(0)} v=${o.v.toFixed(1)} stopped=${o.stopped.toFixed(0)}`));
for (const e of net.outCar[target]) console.log(`out ${e} ${net.edgeName(e)} len${net.edgeLen[e].toFixed(0)} L${net.edgeLanes[e]} cnt ${eng.cnt[e]} closed ${eng.closed[e]} last ${eng.lanes[e].map((l) => l.length ? `s=${l[l.length - 1].s.toFixed(0)}` : '-').join('|')} to-node ${net.edgeTo[e]}`);
console.log('pedBlock', net.inAll[target].map((e) => eng.pedBlock[e * 2]), 'peds waiting', sim.sig.pedWaiting[target]);
