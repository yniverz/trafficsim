import fs from 'node:fs';
import { Simulation } from '../src/sim/sim.ts';
const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const sim = new Simulation(data, { demand: { agents: 25000, seed: 42, startHour: 5, endHour: 24 } as any, strategy: 'smart', startTime: 5 * 3600 });
const cnt = [0, 0, 0, 0]; const purp: Record<number, number> = {};
for (const a of sim.agents) for (const t of a.trips) { cnt[t.mode]++; purp[t.purpose] = (purp[t.purpose] || 0) + 1; }
const tot = cnt.reduce((a, b) => a + b, 0);
console.log('planned trips', tot, 'walk/bike/car/pt shares', cnt.map((c) => (c / tot * 100).toFixed(1) + '%').join(' '));
console.log('purposes', purp);
let d = 0, n = 0; for (const a of sim.agents) for (const t of a.trips) { d += Math.hypot(t.from.x - t.to.x, t.from.y - t.to.y); n++; }
console.log('mean crow-fly trip distance (m)', (d / n).toFixed(0));
// PT feasibility for random home-work pairs
let ok = 0, tried = 0, tr = 0;
for (const a of sim.agents.slice(0, 3000)) { const t = a.trips[0]; if (!t || t.from.gate) continue; tried++; const p = sim.transit.plan(t.from.x, t.from.y, t.to.x, t.to.y); if (p) { ok++; if (p.rides.length > 1) tr++; } }
console.log('pt feasible for first trips', ok, '/', tried, 'with transfer', tr);
