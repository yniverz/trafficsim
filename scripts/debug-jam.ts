import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';
const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const sim = new Simulation(data, { demand: { agents: 50000, seed: 42, startHour: 6.5, endHour: 24 } as any, strategy: (process.argv[2] || 'fixed') as any, startTime: 6.5 * 3600 });
sim.advance(2 * 3600);
const net = sim.net, eng = sim.eng;
const veh = eng.vehicles;
const stuck = veh.filter((v) => v.stopped > 300);
console.log('vehicles', veh.length, 'stopped>5min', stuck.length, 'by type', [0, 1, 2, 3].map((t) => stuck.filter((v) => v.type === t).length));
// heads of lanes that are stuck
const heads: any[] = [];
for (const v of stuck) {
  const lane = v.type === 3 ? eng.bikes[v.edge] : eng.lanes[v.edge][v.lane];
  if (lane[0] === v) heads.push(v);
}
console.log('stuck heads', heads.length);
const reasons: Record<string, number> = {};
for (const v of heads.slice(0, 400)) {
  const nxt = v.route[v.ri + 1];
  if (nxt === undefined) { reasons['end'] = (reasons['end'] || 0) + 1; continue; }
  const n = net.edgeTo[v.edge];
  const ok = (eng as any).canEnter(v, n, v.edge, nxt, net.edgeLen[v.edge] - net.stopOff[v.edge] - v.s, v.type === 3);
  const key = ok ? 'ok(but stopped)' : 'why' + (eng as any).why;
  reasons[key] = (reasons[key] || 0) + 1;
}
console.log(reasons);
const sample = heads.slice(0, 8);
for (const v of sample) {
  const nxt = v.route[v.ri + 1]; const n = net.edgeTo[v.edge];
  console.log(`type ${v.type} edge ${v.edge} cls ${net.edgeCls[v.edge]} s=${v.s.toFixed(0)}/${net.edgeLen[v.edge].toFixed(0)} node ${n} sig ${net.nodeSignal[n]} status ${sim.sig.status[v.edge]} wait ${v.wait.toFixed(0)} stopped ${v.stopped.toFixed(0)} occ ${eng.occV[n].length} next ${nxt} nextCnt ${nxt !== undefined ? eng.cnt[nxt] : '-'}  x=${net.nodeX[n].toFixed(0)} y=${net.nodeY[n].toFixed(0)}`);
}
// pedestrians waiting long
const pw = sim.peds.peds.filter((p) => p.state === 1 && sim.t - p.waitingSince > 300);
console.log('peds waiting > 5min', pw.length);
for (const p of pw.slice(0, 5)) {
  const n = p.crossNode;
  console.log(`ped at node ${n} sig ${net.nodeSignal[n]} cross ${net.nodeCross[n]} arms ${p.crossArms.length} waited ${(sim.t - p.waitingSince).toFixed(0)} pedOK ${net.nodeSignal[n] ? sim.sig.pedOK(n, p.crossArms) : (sim.peds as any).gapOK(n, p.crossArms, 999)} ctrl ${sim.sig.byNode.get(n) ? JSON.stringify({ sub: sim.sig.byNode.get(n)!.sub, disp: sim.sig.byNode.get(n)!.disp, t: sim.sig.byNode.get(n)!.t, phases: sim.sig.byNode.get(n)!.phases.length }) : '-'}`);
  for (const a of p.crossArms) console.log('   arm', a.key, 'in', a.inEdges.map((e: number) => `${e}:st${sim.sig.status[e]}:cnt${eng.cnt[e]}`), 'out', a.outEdges);
}
