import fs from 'node:fs';
import { Network } from '../src/sim/network.ts';
import { SignalSystem } from '../src/sim/signals.ts';
const data = JSON.parse(fs.readFileSync('public/data/karlsruhe.json', 'utf8'));
const net = new Network(data);
const sig = new SignalSystem(net, 1);
const hist: Record<number, number> = {}; const ins: Record<number, number> = {};
let cyc = 0;
for (const c of sig.controllers) { hist[c.phases.length] = (hist[c.phases.length] || 0) + 1; const n = net.inAll[c.node].length; ins[n] = (ins[n] || 0) + 1; cyc += c.cycle; }
console.log('controllers', sig.controllers.length, 'phases hist', hist, 'inEdges hist', ins, 'avg cycle', (cyc / sig.controllers.length).toFixed(0));
const stopoff = [...net.stopOff].filter((x) => x > 0); stopoff.sort((a, b) => a - b);
console.log('stopOff median', stopoff[stopoff.length >> 1], 'p90', stopoff[Math.floor(stopoff.length * 0.9)]);
const len = [...net.edgeLen].filter((_, i) => net.edgeMode[i] === 0 && net.edgeLanes[i] > 0); len.sort((a, b) => a - b);
console.log('road edge len p10', len[Math.floor(len.length * 0.1)], 'median', len[len.length >> 1]);
