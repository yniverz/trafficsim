import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';
const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const sim = new Simulation(data, { demand: { agents: 6000, seed: 42, startHour: 6.5, endHour: 24 } as any, strategy: 'fixed', startTime: 6.5 * 3600 });
sim.advance(3600);
const net = sim.net;
const trams = sim.eng.vehicles.filter((v) => v.type === 2);
console.log('trams', trams.length);
const byLine = new Map<number, number>();
for (const v of trams) byLine.set(v.line.id, (byLine.get(v.line.id) || 0) + 1);
console.log([...byLine].map(([l, n]) => `${sim.data.lines[l].ref}:${n}`).join(' '));
let stuck = trams.filter((v) => v.stopped > 120);
console.log('stuck >120s', stuck.length);
for (const v of stuck.slice(0, 12)) {
  const e = v.edge;
  const n = net.edgeTo[e];
  console.log(`tram line ${v.line.data.ref} edge ${e} s=${v.s.toFixed(0)}/${net.edgeLen[e].toFixed(0)} v=${v.v.toFixed(1)} stopped=${v.stopped.toFixed(0)} dwell=${v.dwell} ptr=${v.stopPtr}/${v.line.stops.length} ri=${v.ri}/${v.route.length} node=${n} sig=${net.nodeSignal[n]} occ=${sim.eng.occV[n].length} stopOff=${net.stopOff[e].toFixed(1)}`);
  const nxt = v.route[v.ri + 1];
  console.log('  next', nxt, 'status', sim.sig.status[e], 'ped', sim.eng.pedBlock[e * 2], sim.eng.pedBlock[nxt * 2 + 1], 'acc', v.acc.toFixed(2));
}
const buses = sim.eng.vehicles.filter((v) => v.type === 1);
console.log('buses', buses.length, 'stuck', buses.filter((v) => v.stopped > 120).length);
for (const v of stuck.slice(0, 3)) {
  const sp = v.line.stops[v.stopPtr];
  console.log('--- tram', v.line.data.ref, 'edge', v.edge, 's', v.s.toFixed(1), 'len', v.len, 'stop', JSON.stringify(sp), 'edge len', net.edgeLen[sp.routeIdx >= 0 ? v.route[sp.routeIdx] : 0]);
  const lane = sim.eng.lanes[v.edge][v.lane];
  const i = lane.indexOf(v);
  console.log(' lane idx', i, 'of', lane.length, 'leader', i > 0 ? `s=${lane[i - 1].s.toFixed(1)} len=${lane[i - 1].len} v=${lane[i - 1].v.toFixed(1)} type=${lane[i - 1].type}` : 'none');
  const nxt = v.route[v.ri + 1];
  const nl = sim.eng.lanes[nxt];
  console.log(' next edge', nxt, 'lanes', nl.map((l) => l.length), 'lastveh', nl[0].length ? `s=${nl[0][nl[0].length - 1].s.toFixed(1)} len=${nl[0][nl[0].length - 1].len} v=${nl[0][nl[0].length - 1].v.toFixed(2)}` : '-');
  const n = net.edgeTo[v.edge];
  console.log(' node', n, 'inAll', net.inAll[n], 'occ', sim.eng.occV[n].map((o) => o.id + ':' + o.type));
}
console.log('=== heads of stuck queues');
let shown = 0;
for (const v of trams) {
  const lane = sim.eng.lanes[v.edge][v.lane];
  if (lane[0] !== v || v.stopped < 120 || shown++ > 6) continue;
  const sp = v.line.stops[v.stopPtr];
  const nxt = v.route[v.ri + 1];
  const n = net.edgeTo[v.edge];
  console.log(`head line ${v.line.data.ref} edge ${v.edge} s=${v.s.toFixed(1)}/${net.edgeLen[v.edge].toFixed(1)} v=${v.v} acc=${v.acc.toFixed(2)} dwell=${v.dwell} ptr=${v.stopPtr} stop=${sp ? JSON.stringify(sp) : '-'} ri=${v.ri} next=${nxt}`);
  if (nxt !== undefined) {
    // replicate canEnter
    console.log('   closed', sim.eng.closed[nxt], 'pedblock', sim.eng.pedBlock[v.edge * 2], sim.eng.pedBlock[nxt * 2 + 1], 'node ins', net.inAll[n].map((ie) => { const w = sim.eng.frontLane(ie); return `${ie}:${w ? `s=${w.s.toFixed(0)} v=${w.v.toFixed(1)} nxt=${w.route[w.ri + 1]}` : '-'}`; }), 'occ', sim.eng.occV[n].map((o) => `${o.id}:${o.type}:${sim.eng.occIn[n][sim.eng.occV[n].indexOf(o)]}>${sim.eng.occOut[n][sim.eng.occV[n].indexOf(o)]}`));
  }
}
console.log('=== reasons');
shown = 0;
for (const v of trams) {
  const lane = sim.eng.lanes[v.edge][v.lane];
  if (lane[0] !== v || v.stopped < 120 || shown++ > 8) continue;
  const nxt = v.route[v.ri + 1];
  const n = net.edgeTo[v.edge];
  const ok = (sim.eng as any).canEnter(v, n, v.edge, nxt, net.edgeLen[v.edge] - net.stopOff[v.edge] - v.s, false);
  console.log('tram', v.id, 'ok', ok, 'why', (sim.eng as any).why, 'occ', sim.eng.occV[n].map((o, i) => `${o.id}(${o.type},len ${o.len}) ${sim.eng.occIn[n][i]}>${sim.eng.occOut[n][i]} on e${o.edge} s=${o.s.toFixed(0)}`), 'mine', v.edge, '>', nxt);
}
