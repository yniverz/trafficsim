(globalThis as any).SMART_OFF = process.env.SMART_OFF || '';
// Compare signal strategies on identical demand (same seed). Usage:
//   npx tsx scripts/benchmark.ts [agents=30000] [startHour=6.5] [hours=3] [tramPriority=0|1] [strategies=comma list]
import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';
import type { Strategy } from '../src/sim/signals.ts';

const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const agents = +(process.argv[2] || 30000);
const start = +(process.argv[3] || 6.5);
const hours = +(process.argv[4] || 3);
const tp = process.argv[5] === '1';
const strategies = (process.argv[6] || 'fixed,actuated,greenwave,maxpressure,smart').split(',') as Strategy[];
const seeds = (process.argv[7] || '1').split(',').map(Number);

const rows: any[] = [];
for (const strategy of strategies) {
  const acc: any = {};
  for (const seed of seeds) {
    const sim = new Simulation(data, {
      demand: { agents, seed: 42, startHour: start, endHour: 24 } as any,
      strategy, startTime: start * 3600, seed,
      signal: { tramPriority: tp }, gating: process.env.GATING === '1',
    });
    const t0 = Date.now();
    sim.advance(hours * 3600);
    sim.metrics.teleports = sim.eng.teleports;
    const m = sim.metrics.summary();
    const s = sim.stats();
    const r = {
      carDelay: m.trips[2].avgDelay, carP90: m.trips[2].p90Delay, carP99: m.trips[2].p99Delay, carTime: m.trips[2].avgTime, carN: m.trips[2].n,
      bikeDelay: m.trips[1].avgDelay, bikeN: m.trips[1].n,
      walkDelay: m.trips[0].avgDelay, ptDelay: m.trips[3].avgDelay, ptN: m.trips[3].n,
      pedWait: m.pedWaitAvg, tramLate: m.tramLateShare * 100, tramDelay: m.tramDelayAvg, busDelay: m.busDelayAvg, busLate: m.busLateShare * 100,
      pHoursLost: m.personHoursLost, tele: m.teleports, pending: s.pending, spawnWait: m.spawnWaitAvg, wall: (Date.now() - t0) / 1000,
    } as Record<string, number>;
    for (const k in r) acc[k] = (acc[k] || 0) + r[k] / seeds.length;
  }
  rows.push({ strategy, ...acc });
  console.error(strategy, 'done');
}
const f = (x: number, d = 0) => x.toFixed(d);
console.log(`\nagents=${agents} window=${start}h+${hours}h tramPriority=${tp} seeds=${seeds.join(',')}`);
console.log('strategy      carDelay  p90   p99 carN  bikeDelay walkDelay ptDelay pedWait tramLate% busLate% tramDelay personH  teleports spawnWait');
for (const r of rows) {
  console.log(`${r.strategy.padEnd(13)} ${f(r.carDelay).padStart(7)}s ${f(r.carP90).padStart(4)} ${f(r.carP99).padStart(5)} ${f(r.carN).padStart(5)} ${f(r.bikeDelay).padStart(8)}s ${f(r.walkDelay).padStart(8)}s ${f(r.ptDelay).padStart(6)}s ${f(r.pedWait, 1).padStart(6)}s ${f(r.tramLate, 1).padStart(8)} ${f(r.busLate, 1).padStart(7)} ${f(r.tramDelay).padStart(8)}s ${f(r.pHoursLost).padStart(7)} ${f(r.tele).padStart(8)} ${f(r.spawnWait).padStart(8)}s`);
}
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync(`results/bench-${agents}-${start}-${hours}-tp${tp ? 1 : 0}.json`, JSON.stringify(rows, null, 1));

if (process.env.PUBLISH === '1') {
  const meta = `${agents / 1000}k agents · ${String(Math.floor(start)).padStart(2, '0')}:${start % 1 ? '30' : '00'}–${String(Math.floor(start + hours)).padStart(2, '0')}:${(start + hours) % 1 ? '30' : '00'} · mean of ${seeds.length} run${seeds.length > 1 ? 's' : ''}${tp ? ' · tram priority on' : ''}`;
  fs.writeFileSync('public/data/benchmark.json', JSON.stringify({ meta, rows }, null, 1));
  console.log('published', meta);
}
