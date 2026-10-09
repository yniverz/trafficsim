import './style.css';
import { Simulation } from './sim/sim';
import { World } from './render/world';
import { STRATEGY_INFO, type Strategy } from './sim/signals';
import { M_ROAD } from './sim/network';
import { F_CAR } from './sim/types';
import { MODE_NAMES, PURPOSE_NAMES, PS_CROSSING, PS_WAITCROSS, PS_WAITSTOP, PS_WALK, type Ped } from './sim/agents';
import type { Vehicle } from './sim/engine';
import { VT_BIKE, VT_BUS, VT_CAR, VT_TRAM } from './sim/engine';
import { drawChart } from './ui/chart';
import type { NetworkData } from './sim/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function progress(p: number, text: string) {
  $('loadBar').style.width = `${Math.round(p * 100)}%`;
  $('loadText').textContent = text;
}

let sim: Simulation;
let world: World;
let speed = 20;
let simBudget = 0;
let closeTool = false;
const closed = new Set<number>(); // canonical edge ids
let selected: { kind: 'veh'; v: Vehicle } | { kind: 'ped'; p: Ped } | null = null;

async function boot() {
  progress(0.05, 'Downloading the Karlsruhe road network…');
  const res = await fetch(import.meta.env.BASE_URL + 'data/karlsruhe.json');
  const data = (await res.json()) as NetworkData;
  progress(0.3, 'Building road graph and signal plans…');
  await nextFrame();
  sim = new Simulation(data, {
    demand: { agents: 25000, seed: 42, startHour: 6.5, endHour: 24, externalShare: 0.2, throughShare: 0.05, carShare: 1 },
    strategy: 'fixed',
    startTime: 6.5 * 3600,
  } as any);
  progress(0.55, `Placing ${sim.agents.length.toLocaleString()} people with daily plans…`);
  await nextFrame();
  progress(0.7, 'Extruding 11,000 buildings…');
  await nextFrame();
  world = new World($('view') as HTMLCanvasElement, sim);
  progress(1, 'Ready');
  setupUI();
  setupInteraction();
  loadBenchmark();
  $('loading').classList.add('done');
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------- loop
let lastT = performance.now();
let lastUi = 0;
function frame(now: number) {
  const dtReal = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (speed > 0) {
    simBudget += speed * dtReal;
    const t0 = performance.now();
    const limit = speed >= 240 ? 14 : 9;
    while (simBudget >= sim.dt) {
      sim.step();
      simBudget -= sim.dt;
      if (performance.now() - t0 > limit) {
        simBudget = Math.min(simBudget, sim.dt * 2);
        break;
      }
    }
  }
  world.update(now);
  if (now - lastUi > 400) {
    lastUi = now;
    updateStats();
  }
  updateSelectionCard();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------- UI
const fmtT = (t: number) => {
  const h = Math.floor(t / 3600) % 24, m = Math.floor((t % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const fmt = (x: number, d = 0) => x.toLocaleString('en', { maximumFractionDigits: d, minimumFractionDigits: d });

function setupUI() {
  // strategies
  const box = $('strategies');
  (Object.keys(STRATEGY_INFO) as Strategy[]).forEach((k) => {
    const b = document.createElement('div');
    b.className = 'strat' + (k === sim.config.strategy ? ' on' : '');
    b.dataset.k = k;
    b.innerHTML = `<b>${STRATEGY_INFO[k].label}</b><span>${STRATEGY_INFO[k].blurb}</span>`;
    b.onclick = () => {
      sim.setStrategy(k);
      box.querySelectorAll('.strat').forEach((e) => e.classList.toggle('on', (e as HTMLElement).dataset.k === k));
      $('waveRow').style.opacity = k === 'greenwave' ? '1' : '0.4';
    };
    box.appendChild(b);
  });
  $('waveRow').style.opacity = '0.4';
  $<HTMLInputElement>('tramPrio').onchange = (e) => sim.setSignalParams({ tramPriority: (e.target as HTMLInputElement).checked });
  const bind = (id: string, valId: string, fmtv: (v: number) => string, apply: (v: number) => void) => {
    const el = $<HTMLInputElement>(id);
    const upd = () => { $(valId).textContent = fmtv(+el.value); };
    el.oninput = () => { upd(); apply(+el.value); };
    upd();
  };
  bind('cycle', 'cycleVal', (v) => `${v} s`, (v) => sim.setSignalParams({ cycle: v }));
  bind('pedWait', 'pedWaitVal', (v) => `${v} s`, (v) => sim.setSignalParams({ pedMaxWait: v }));
  bind('agents', 'agentsVal', (v) => `${v}k`, () => {});
  bind('carShare', 'carShareVal', (v) => `${v}%`, () => {});
  $<HTMLSelectElement>('waveDir').onchange = (e) => sim.setSignalParams({ waveDirection: (e.target as HTMLSelectElement).value as any });
  $('btnRestart').onclick = restart;

  $('speedGroup').querySelectorAll('button').forEach((b) => {
    (b as HTMLElement).onclick = () => setSpeed(+(b as HTMLElement).dataset.speed!);
  });
  $('viewGroup').querySelectorAll('button').forEach((b) => {
    (b as HTMLElement).onclick = () => setView((b as HTMLElement).dataset.view as '2d' | '3d');
  });
  $('btnPanels').onclick = () => document.body.classList.toggle('hidepanels');
  $('btnStats').onclick = () => { document.body.classList.remove('hidepanels'); document.body.classList.toggle('showright'); };
  $<HTMLSelectElement>('roadColor').onchange = (e) => world.setRoadColorMode((e.target as HTMLSelectElement).value as any);
  $<HTMLSelectElement>('vehColor').onchange = (e) => { world.vehicleColorMode = (e.target as HTMLSelectElement).value as any; };
  $<HTMLInputElement>('showBuildings').onchange = (e) => world.setBuildingsVisible((e.target as HTMLInputElement).checked);
  $<HTMLInputElement>('lightTheme').onchange = (e) => {
    const light = (e.target as HTMLInputElement).checked;
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    world.setDark(!light);
  };
  $('btnClose').onclick = () => {
    closeTool = !closeTool;
    $('btnClose').classList.toggle('on', closeTool);
    $('btnClose').textContent = closeTool ? 'Click a street… (esc to stop)' : 'Close a road to cars…';
  };
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); setSpeed(speed === 0 ? 20 : 0); }
    else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('hidepanels');
    else if (e.key === 'v' || e.key === 'V') setView(world.mode === '2d' ? '3d' : '2d');
    else if (e.key === 'Escape') { selectNone(); closeTool = false; $('btnClose').classList.remove('on'); $('btnClose').textContent = 'Close a road to cars…'; }
    else if (['1', '2', '3', '4', '5'].includes(e.key)) setSpeed([1, 5, 20, 60, 240][+e.key - 1]);
  });
  setSpeed(20);
  updateStats();
}

function setSpeed(s: number) {
  speed = s;
  $('speedGroup').querySelectorAll('button').forEach((b) => b.classList.toggle('on', +(b as HTMLElement).dataset.speed! === s));
}

function setView(v: '2d' | '3d') {
  world.setMode(v);
  $('viewGroup').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.view === v));
}

function restart() {
  const n = +$<HTMLInputElement>('agents').value * 1000;
  const car = +$<HTMLInputElement>('carShare').value / 100;
  const startH = +$<HTMLSelectElement>('startHour').value;
  Object.assign(sim.config.demand, { agents: n, carShare: car, startHour: startH });
  sim.config.startTime = startH * 3600;
  selectNone();
  const btn = $('btnRestart');
  btn.textContent = 'Generating population…';
  setTimeout(() => {
    sim.build();
    for (const c of closed) sim.closeEdge(c, true);
    btn.textContent = 'Apply & restart';
    updateStats();
  }, 30);
}

function trafficLight(v: number, goodBelow: number, badAbove: number) {
  return v < goodBelow ? 'good' : v > badAbove ? 'bad' : 'warn';
}

function updateStats() {
  const s = sim.stats();
  const m = sim.metrics.summary();
  $('clock').textContent = fmtT(sim.t);
  const series = sim.metrics.series;
  const last = series[series.length - 1];
  const speedKmh = last ? last.meanSpeed * 3.6 : 0;
  const live = [
    kpi('Cars driving', fmt(s.cars), ''),
    kpi('Bikes', fmt(s.bikes), ''),
    kpi('Pedestrians', fmt(s.peds), ''),
    kpi('Trams · buses', `${s.trams} · ${s.buses}`, ''),
    kpi('Mean car speed', `${fmt(speedKmh)} km/h`, last ? trafficLight(-speedKmh, -26, -14) : ''),
    kpi('Standing cars', last ? `${fmt(last.stopped * 100)} %` : '–', last ? trafficLight(last.stopped, 0.18, 0.4) : ''),
  ];
  $('kpisLive').innerHTML = live.join('');
  const rows = m.trips.map((t) => `<tr><td>${t.mode}</td><td>${fmt(t.n)}</td><td>${fmt(t.avgTime / 60, 1)}</td><td>${fmt(t.avgDelay / 60, 1)}</td></tr>`).join('');
  $('tripTable').innerHTML = `<tr><th>Mode</th><th>trips</th><th>avg min</th><th>delay min</th></tr>${rows}`;
  const lateT = m.tramLateShare * 100;
  const pt = [
    kpi('Tram late (&gt;3 min)', `${fmt(lateT, 1)} %`, trafficLight(lateT, 2, 8)),
    kpi('Bus late (&gt;3 min)', `${fmt(m.busLateShare * 100, 1)} %`, trafficLight(m.busLateShare * 100, 3, 10)),
    kpi('Avg tram delay', `${fmt(m.tramDelayAvg)} s`, trafficLight(m.tramDelayAvg, 20, 60)),
    kpi('Pedestrian wait', `${fmt(m.pedWaitAvg, 1)} s`, trafficLight(m.pedWaitAvg, 8, 25)),
    kpi('Waiting at stops', fmt(s.waitingAtStops), ''),
    kpi('Gridlock teleports', fmt(sim.eng.teleports), trafficLight(sim.eng.teleports, 1, 20)),
    kpi('People-hours lost', fmt(m.personHoursLost), ''),
    kpi('Cars not yet in', fmt(s.pending), trafficLight(s.pending, 5, 50)),
  ];
  $('kpisPt').innerHTML = pt.join('');
  drawChart($('chart') as HTMLCanvasElement, series, sim.config.demand.startHour * 3600);
}

function kpi(label: string, value: string, cls: string) {
  return `<div class="kpi ${cls}"><b>${value}</b><span>${label}</span></div>`;
}

async function loadBenchmark() {
  try {
    const r = await fetch(import.meta.env.BASE_URL + 'data/benchmark.json');
    if (!r.ok) return;
    const j = await r.json();
    const rows = j.rows as any[];
    const best = (k: string) => Math.min(...rows.map((x) => x[k]));
    const cell = (x: any, k: string, d = 0) => `<td class="${x[k] === best(k) ? 'best' : ''}">${fmt(x[k], d)}</td>`;
    $('bench').innerHTML = `<table><tr><th>strategy</th><th>car delay s</th><th>p90</th><th>tram late %</th><th>ped wait s</th><th>people-h lost</th></tr>${rows
      .map((x) => `<tr><td>${STRATEGY_INFO[x.strategy as Strategy]?.label.split(' (')[0].split(':')[0] ?? x.strategy}</td>${cell(x, 'carDelay')}${cell(x, 'carP90')}${cell(x, 'tramLate', 1)}${cell(x, 'pedWait', 1)}${cell(x, 'pHoursLost')}</tr>`)
      .join('')}</table>`;
    $('benchMeta').textContent = j.meta;
  } catch {
    /* optional */
  }
}

// ---------------------------------------------------------------------------- interaction
function setupInteraction() {
  const canvas = $('view') as HTMLCanvasElement;
  const tip = $('tooltip');
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5) return;
    const g = ground(e);
    if (!g) return;
    if (closeTool) {
      const net = sim.net;
      const hit = net.nearestEdge(g.x, g.y, (ed) => net.edgeMode[ed] === M_ROAD && net.edgeLanes[ed] > 0 && (net.edgeFlags[ed] & F_CAR) !== 0, 40);
      if (hit) toggleClosure(hit.edge);
      return;
    }
    const pick = nearestAgent(g.x, g.y, world.mode === '2d' ? 9 / world.ortho.zoom * (world.viewSize / 1800) + 4 : 12);
    if (pick) {
      selected = pick;
      world.setFollow(pick);
    } else selectNone();
  });
  canvas.addEventListener('pointermove', (e) => {
    const g = ground(e);
    if (!g) { tip.hidden = true; return; }
    let text = '';
    if (closeTool) {
      const net = sim.net;
      const hit = net.nearestEdge(g.x, g.y, (ed) => net.edgeMode[ed] === M_ROAD && net.edgeLanes[ed] > 0 && (net.edgeFlags[ed] & F_CAR) !== 0, 40);
      if (hit) text = `${net.edgeName(hit.edge) || 'street'} · click to ${sim.eng.closed[hit.edge] ? 'reopen' : 'close'}`;
    } else {
      const pick = nearestAgent(g.x, g.y, 12);
      if (pick) text = describe(pick, true);
      else {
        const st = nearestStop(g.x, g.y, 22);
        if (st) text = `${st.mode === 'tram' ? '🚊' : '🚌'} ${st.name}`;
        else {
          const sg = nearestSignal(g.x, g.y, 25);
          if (sg) text = `🚦 signal · phase ${sg.disp + 1}/${sg.phases.length}`;
        }
      }
    }
    if (text) {
      tip.hidden = false;
      tip.textContent = text;
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY + 14}px`;
    } else tip.hidden = true;
  });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
}

function ground(e: PointerEvent | MouseEvent) {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  return world.pick(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
}

function nearestAgent(x: number, y: number, r: number): typeof selected {
  let best: typeof selected = null;
  let bd = r;
  for (const v of sim.eng.vehicles) {
    const d = Math.hypot(v.x - x, v.y - y) - (v.type === VT_TRAM ? 8 : v.type === VT_BUS ? 3 : 0);
    if (d < bd) { bd = d; best = { kind: 'veh', v }; }
  }
  for (const p of sim.peds.peds) {
    if (p.state === 4) continue;
    const d = Math.hypot(p.x - x, p.y - y) + 1;
    if (d < bd) { bd = d; best = { kind: 'ped', p }; }
  }
  return best;
}

function nearestStop(x: number, y: number, r: number) {
  let best = null as null | (typeof sim.data.stops)[number];
  let bd = r;
  for (const s of sim.data.stops) {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function nearestSignal(x: number, y: number, r: number) {
  let best = null as null | (typeof sim.sig.controllers)[number];
  let bd = r;
  for (const c of sim.sig.controllers) {
    const d = Math.hypot(sim.net.nodeX[c.node] - x, sim.net.nodeY[c.node] - y);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function describe(sel: NonNullable<typeof selected>, short = false): string {
  const net = sim.net;
  if (sel.kind === 'veh') {
    const v = sel.v;
    const street = net.edgeName(v.edge);
    const kmh = Math.round(v.v * 3.6);
    if (v.type === VT_TRAM || v.type === VT_BUS) {
      const l = v.line?.data;
      const label = `${v.type === VT_TRAM ? '🚊 Tram' : '🚌 Bus'} ${l?.ref ?? ''}`;
      return short ? `${label} · ${kmh} km/h · ${v.pax.length} aboard` : `${label} · ${kmh} km/h · ${v.pax.length} passengers · ${v.schedDelay > 60 ? `${Math.round(v.schedDelay / 60)} min late` : 'on time'}`;
    }
    const purpose = v.owner?.trip ? PURPOSE_NAMES[v.owner.trip.purpose] : '';
    const label = v.type === VT_BIKE ? '🚲 Bike' : '🚗 Car';
    return short ? `${label} · ${kmh} km/h${street ? ' · ' + street : ''}` : `${label} · ${kmh} km/h · ${street || 'unnamed street'}${purpose ? ' · trip purpose: ' + purpose : ''}`;
  }
  const p = sel.p;
  const st = ['walking', 'waiting to cross', 'crossing', 'waiting at stop', 'riding'][p.state];
  const m = MODE_NAMES[p.trip.mode];
  return `🚶 Pedestrian · ${st}${short ? '' : ` · trip by ${m.toLowerCase()} (${PURPOSE_NAMES[p.trip.purpose]})`}`;
}

function updateSelectionCard() {
  const card = $('info');
  if (!selected) { card.hidden = true; return; }
  if (selected.kind === 'veh' && !selected.v.alive) { selectNone(); return; }
  if (selected.kind === 'ped' && !sim.peds.peds.includes(selected.p)) { selectNone(); return; }
  card.hidden = false;
  card.innerHTML = `<h4>${describe(selected)}</h4><div class="hint">Following · press Esc to release</div>`;
}

function selectNone() {
  selected = null;
  world.setFollow(null);
  $('info').hidden = true;
}

function toggleClosure(e: number) {
  const net = sim.net;
  const rev = net.edgeRev[e];
  const canon = rev >= 0 ? Math.min(e, rev) : e;
  if (closed.has(canon)) closed.delete(canon); else closed.add(canon);
  sim.closeEdge(canon, closed.has(canon));
  const edges: number[] = [];
  const list = $('closedList');
  list.innerHTML = '';
  for (const c of closed) {
    edges.push(c);
    const r = net.edgeRev[c];
    if (r >= 0) edges.push(r);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `✕ ${net.edgeName(c) || 'street #' + c}`;
    chip.onclick = () => toggleClosure(c);
    list.appendChild(chip);
  }
  world.setClosedEdges(edges);
}

boot().catch((e) => {
  console.error(e);
  $('loadText').textContent = 'Failed to load: ' + (e as Error).message;
});

export { PS_CROSSING, PS_WAITCROSS, PS_WAITSTOP, PS_WALK };
