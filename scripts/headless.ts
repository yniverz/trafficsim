// Quick headless smoke test: run N simulated minutes and print stats.
import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';

const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const agents = +(process.argv[2] || 3000);
const minutes = +(process.argv[3] || 60);
const start = +(process.argv[4] || 6.5);
const strategy = (process.argv[5] || 'fixed') as any;
console.time('init');
const sim = new Simulation(data, { demand: { agents, seed: 42, startHour: start, endHour: 24 } as any, strategy, startTime: start * 3600 });
console.timeEnd('init');
console.log('agents', sim.agents.length, 'trips', sim.agents.reduce((a, b) => a + b.trips.length, 0), 'signals', sim.sig.controllers.length);
const t0 = Date.now();
for (let m = 0; m < minutes; m += 5) {
  sim.advance(300);
  const s = sim.stats();
  console.log(`${(sim.t / 3600).toFixed(2)}h cars ${s.cars} bikes ${s.bikes} bus ${s.buses} tram ${s.trams} peds ${s.peds} pend ${s.pending} stop-wait ${s.waitingAtStops}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
}
sim.metrics.teleports = sim.eng.teleports; console.log(JSON.stringify(sim.metrics.summary(), null, 1));
