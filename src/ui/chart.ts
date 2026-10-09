import type { SeriesPoint } from '../sim/metrics';

/** Tiny dependency-free time-series chart: mean car speed, cars on the road, pedestrians waiting. */
export function drawChart(canvas: HTMLCanvasElement, series: SeriesPoint[], t0: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim() || '#8d97ab';
  const pad = { l: 28, r: 6, t: 8, b: 16 };
  const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
  g.font = '10px system-ui, sans-serif';
  g.fillStyle = muted;
  g.strokeStyle = 'rgba(128,140,160,0.25)';
  g.lineWidth = 1;
  // time axis: from start to max(start+1h, last)
  const tEnd = Math.max(t0 + 3600, series.length ? series[series.length - 1].t : t0 + 3600);
  const x = (t: number) => pad.l + ((t - t0) / (tEnd - t0)) * w;
  const hours = Math.ceil((tEnd - t0) / 3600);
  const stepH = hours > 8 ? 2 : 1;
  for (let k = 0; k <= hours; k += stepH) {
    const tt = t0 + k * 3600;
    if (tt > tEnd) break;
    g.beginPath(); g.moveTo(x(tt), pad.t); g.lineTo(x(tt), pad.t + h); g.stroke();
    g.fillText(String(Math.floor(tt / 3600) % 24).padStart(2, '0') + ':00', x(tt) - 12, H - 3);
  }
  if (series.length < 2) return;
  const series1 = series.map((p) => p.meanSpeed * 3.6);
  const maxSpeed = 50;
  const maxCars = Math.max(200, ...series.map((p) => p.vehicles));
  const maxWait = Math.max(20, ...series.map((p) => p.pedWaiting));
  const line = (vals: number[], max: number, color: string, fill = false) => {
    g.beginPath();
    series.forEach((p, i) => {
      const px = x(p.t), py = pad.t + h - (vals[i] / max) * h;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    });
    if (fill) {
      g.lineTo(x(series[series.length - 1].t), pad.t + h); g.lineTo(x(series[0].t), pad.t + h); g.closePath();
      g.fillStyle = color + '22'; g.fill();
    } else { g.strokeStyle = color; g.lineWidth = 1.6; g.stroke(); }
  };
  line(series.map((p) => p.vehicles), maxCars, '#ffc02e', true);
  line(series.map((p) => p.pedWaiting), maxWait, '#ff6b6b');
  line(series1, maxSpeed, '#5b9dff');
  g.fillStyle = muted;
  g.fillText(`${maxSpeed} km/h`, 2, pad.t + 8);
  g.fillText('0', 14, pad.t + h);
}
