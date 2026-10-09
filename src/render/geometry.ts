import * as THREE from 'three';

/** Build a flat ribbon (triangle strip) along a polyline. Coordinates: map (x east, y north) -> world (x, h, -y). */
export function ribbon(pts: ArrayLike<number>, width: number, h: number, out: { pos: number[]; idx: number[]; uv?: number[] }, offset = 0): { start: number; count: number } {
  const n = pts.length / 2;
  const start = out.pos.length / 3;
  if (n < 2) return { start, count: 0 };
  const hw = width / 2;
  // per-vertex miter normals
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i], y = pts[2 * i + 1];
    let nx = 0, ny = 0;
    if (i > 0) {
      const dx = x - pts[2 * i - 2], dy = y - pts[2 * i - 1];
      const l = Math.hypot(dx, dy) || 1;
      nx += -dy / l; ny += dx / l;
    }
    if (i < n - 1) {
      const dx = pts[2 * i + 2] - x, dy = pts[2 * i + 3] - y;
      const l = Math.hypot(dx, dy) || 1;
      nx += -dy / l; ny += dx / l;
    }
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    // limit miter
    let m = 1;
    if (i > 0 && i < n - 1) {
      const dx1 = x - pts[2 * i - 2], dy1 = y - pts[2 * i - 1];
      const dx2 = pts[2 * i + 2] - x, dy2 = pts[2 * i + 3] - y;
      const l1 = Math.hypot(dx1, dy1) || 1, l2 = Math.hypot(dx2, dy2) || 1;
      const c = (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
      m = 1 / Math.max(0.5, Math.sqrt((1 + c) / 2));
    }
    const ox = nx * offset, oy = ny * offset;
    out.pos.push(x + ox + nx * hw * m, h, -(y + oy + ny * hw * m));
    out.pos.push(x + ox - nx * hw * m, h, -(y + oy - ny * hw * m));
  }
  for (let i = 0; i < n - 1; i++) {
    const a = start + 2 * i;
    out.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return { start, count: 2 * n };
}

export function colorLerp(a: THREE.Color, b: THREE.Color, t: number, out: THREE.Color) {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}
