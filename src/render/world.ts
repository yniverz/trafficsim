import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Simulation } from '../sim/sim';
import { LANE_W, M_ROAD, M_TRAM, M_WALK } from '../sim/network';
import { F_BIKEINFRA, F_PEDZONE, F_TUNNEL, F_CAR } from '../sim/types';
import { VT_BIKE, VT_BUS, VT_CAR, VT_TRAM, type Vehicle } from '../sim/engine';
import { PS_CROSSING, PS_RIDING, PS_WAITSTOP, type Ped } from '../sim/agents';
import { ribbon } from './geometry';

export type ViewMode = '2d' | '3d';
export type RoadColorMode = 'class' | 'speed' | 'stops';
export type VehicleColorMode = 'speed' | 'mode';

const MAX_CARS = 12000, MAX_BIKES = 6000, MAX_BUSES = 400, MAX_TRAMS = 300, MAX_PEDS = 14000;

const CLASS_COLORS = [0x4c5467, 0x555e72, 0x5f6980, 0x707b96, 0x8490ae, 0x9aa6c6, 0xaab6d4, 0xbac4de];

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  camera: THREE.Camera;
  controls: OrbitControls;
  mode: ViewMode = '2d';
  roadColorMode: RoadColorMode = 'class';
  vehicleColorMode: VehicleColorMode = 'speed';
  follow: { kind: 'veh'; v: Vehicle } | { kind: 'ped'; p: Ped } | null = null;

  private roads!: THREE.Mesh;
  private roadColors!: THREE.BufferAttribute;
  private edgeVerts: Int32Array;
  private edgeVertN: Int32Array;
  private roadCanon: number[] = [];
  private buildingsMesh!: THREE.Group;
  private carMesh: THREE.InstancedMesh;
  private bikeMesh: THREE.InstancedMesh;
  private busMesh: THREE.InstancedMesh;
  private tramMesh: THREE.InstancedMesh;
  private pedMesh: THREE.InstancedMesh;
  private sigMesh!: THREE.InstancedMesh;
  private sigEdges: number[] = [];
  private stopMesh!: THREE.InstancedMesh;
  private closedMesh!: THREE.Line;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private yAxis = new THREE.Vector3(0, 1, 0);
  private pose = { x: 0, y: 0, h: 0 };
  private cA = new THREE.Color(0xff3b3b);
  private cB = new THREE.Color(0xffc93b);
  private cC = new THREE.Color(0x3bff7a);
  private lastHeat = 0;
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dark = true;
  viewSize = 1800;

  constructor(private canvas: HTMLCanvasElement, private sim: Simulation) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x0e1117);
    this.scene.fog = new THREE.Fog(0x0e1117, 2500, 7000);

    const b = sim.data.bounds;
    this.persp = new THREE.PerspectiveCamera(55, 1, 1, 12000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 8000);
    this.camera = this.ortho;
    this.controls = new OrbitControls(this.ortho, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    this.controls.target.set(cx - 200, 0, -cy);
    this.ortho.position.set(cx - 200, 3000, -cy);
    this.ortho.zoom = 0.62;

    this.hemi = new THREE.HemisphereLight(0xaab8e8, 0x1a1d27, 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 1.1);
    this.sun.position.set(-600, 900, 400);
    this.scene.add(this.sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshBasicMaterial({ color: 0x141821 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.3;
    this.scene.add(ground);

    this.edgeVerts = new Int32Array(sim.net.E).fill(-1);
    this.edgeVertN = new Int32Array(sim.net.E);
    this.buildRoads();
    this.buildBuildings();

    // vehicles
    const carGeo = this.carGeometry();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.carMesh = this.inst(carGeo, mat, MAX_CARS);
    this.busMesh = this.inst(this.boxGeo(1, 1, 1, 0.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_BUSES);
    this.tramMesh = this.inst(this.boxGeo(1, 1, 1, 0.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_TRAMS);
    this.bikeMesh = this.inst(this.boxGeo(1, 1, 1, 0.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_BIKES);
    const pg = new THREE.CapsuleGeometry(0.28, 1.1, 2, 6);
    pg.translate(0, 0.85, 0);
    this.pedMesh = this.inst(pg, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_PEDS);
    this.buildSignals();
    this.buildStops();

    // closed roads overlay
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    this.closedMesh = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xff3b3b }));
    this.scene.add(this.closedMesh);

    this.setMode('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ------------------------------------------------------------------ construction
  private inst(geo: THREE.BufferGeometry, mat: THREE.Material, max: number) {
    const m = new THREE.InstancedMesh(geo, mat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }

  private boxGeo(w: number, h: number, d: number, yOff: number) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, yOff * h, 0);
    return g;
  }

  /** Car with darker cabin: unit-length body (x), height 1.5 */
  private carGeometry() {
    const body = new THREE.BoxGeometry(1, 0.62, 1).toNonIndexed();
    body.translate(0, 0.62 / 2 + 0.25, 0);
    const cabin = new THREE.BoxGeometry(0.52, 0.48, 0.88).toNonIndexed();
    cabin.translate(-0.05, 0.62 + 0.25 + 0.24, 0);
    const paint = (g: THREE.BufferGeometry, c: number) => {
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      const k = new THREE.Color(c);
      for (let i = 0; i < n; i++) { col[3 * i] = k.r; col[3 * i + 1] = k.g; col[3 * i + 2] = k.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    };
    paint(body, 0xffffff);
    paint(cabin, 0x6b7385);
    for (const g of [body, cabin]) g.deleteAttribute('uv');
    return mergeGeometries([body, cabin])!;
  }

  private buildRoads() {
    const sim = this.sim, net = sim.net, d = sim.data;
    const pos: number[] = [], idx: number[] = [], cols: number[] = [];
    const side: { pos: number[]; idx: number[] } = { pos: [], idx: [] };
    const foot: { pos: number[]; idx: number[] } = { pos: [], idx: [] };
    const rail: { pos: number[]; idx: number[] } = { pos: [], idx: [] };
    const bike: { pos: number[]; idx: number[] } = { pos: [], idx: [] };
    const out = { pos, idx };
    const seen = new Set<number>();
    const col = new THREE.Color();
    for (let e = 0; e < net.E; e++) {
      const ed = d.edges[e];
      const rev = net.edgeRev[e];
      const canon = rev >= 0 ? Math.min(e, rev) : e;
      if (seen.has(canon)) continue;
      seen.add(canon);
      if (net.edgeMode[e] === M_WALK) {
        ribbon(net.edgePts[e], ed.flags & F_PEDZONE ? 4.5 : 1.6, 0.04, foot);
      } else if (net.edgeMode[e] === M_TRAM) {
        ribbon(net.edgePts[e], 2.6, 0.12, rail);
      } else if (net.edgeLanes[e] === 0) {
        ribbon(net.edgePts[e], 2.0, 0.05, bike);
      } else {
        const lanes = net.edgeLanes[e] * (rev >= 0 ? 2 : 1);
        const w = lanes * LANE_W;
        const tunnel = (ed.flags & F_TUNNEL) !== 0;
        const h = tunnel ? 0.0 : 0.06 + ed.cls * 0.004;
        const r = ribbon(net.edgePts[e], w, h, out);
        for (const ee of rev >= 0 ? [e, rev] : [e]) { this.edgeVerts[ee] = r.start; this.edgeVertN[ee] = r.count; }
        this.roadCanon.push(canon);
        col.setHex(tunnel ? 0x262a35 : CLASS_COLORS[Math.min(7, ed.cls)]);
        for (let i = 0; i < r.count; i++) cols.push(col.r, col.g, col.b);
        if (!tunnel) ribbon(net.edgePts[e], w + 4.6, 0.02, side);
        if (ed.flags & F_BIKEINFRA && !tunnel) ribbon(net.edgePts[e], w + 1.2, 0.045, bike);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.roadColors = new THREE.Float32BufferAttribute(cols, 3);
    this.roadColors.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', this.roadColors);
    g.setIndex(idx);
    this.roads = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.scene.add(this.roads);
    const mk = (b: { pos: number[]; idx: number[] }, color: number, opacity = 1, order = 0) => {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      bg.setIndex(b.idx);
      const m = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity }));
      m.renderOrder = order;
      this.scene.add(m);
      return m;
    };
    mk(side, 0x2a2f3b);
    mk(foot, 0x6c7a8f, 0.9);
    mk(bike, 0x2f6f66, 0.9);
    mk(rail, 0xc0553d, 1);
  }

  private buildBuildings() {
    const d = this.sim.data;
    const geos: THREE.BufferGeometry[] = [];
    const palette: Record<number, number[]> = {
      0: [0x7d8190, 0x8a8e9d, 0x757a8a],
      1: [0x8f8478, 0x9b8f80, 0x84796d],
      2: [0x6e7f96, 0x7a8ba3, 0x657790],
      3: [0xb08a62, 0xbf9a70, 0xa57f58],
      4: [0x7aa08a, 0x86ad96, 0x6f9580],
      5: [0xb06b6b, 0xbf7a7a, 0xa06060],
    };
    const col = new THREE.Color();
    for (let i = 0; i < d.buildings.length; i++) {
      const b = d.buildings[i];
      const n = b.pts.length / 2;
      const shape = new THREE.Shape();
      let last = -1;
      for (let k = 0; k < n; k++) {
        const x = b.pts[2 * k], y = b.pts[2 * k + 1];
        if (k === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
        last = k;
      }
      void last;
      let g: THREE.BufferGeometry;
      try {
        g = new THREE.ExtrudeGeometry(shape, { depth: b.h, bevelEnabled: false });
      } catch {
        continue;
      }
      g.rotateX(-Math.PI / 2);
      const pal = palette[b.kind] || palette[0];
      col.setHex(pal[i % pal.length]);
      const v = 0.9 + ((i * 2654435761) % 100) / 500;
      const nverts = g.attributes.position.count;
      const colors = new Float32Array(nverts * 3);
      for (let k = 0; k < nverts; k++) { colors[3 * k] = col.r * v; colors[3 * k + 1] = col.g * v; colors[3 * k + 2] = col.b * v; }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.deleteAttribute('uv');
      g.deleteAttribute('normal');
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false)!;
    merged.computeVertexNormals();
    this.buildingsMesh = new THREE.Group();
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.buildingsMesh.add(mesh);
    this.scene.add(this.buildingsMesh);
    for (const g of geos) g.dispose();
  }

  private buildSignals() {
    const net = this.sim.net;
    const edges: number[] = [];
    for (const c of this.sim.sig.controllers) for (const ph of c.phases) for (const e of ph.edges) edges.push(e);
    this.sigEdges = edges;
    const g = new THREE.BoxGeometry(1, 0.5, 1);
    this.sigMesh = this.inst(g, new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, edges.length));
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const p = { x: 0, y: 0, h: 0 };
    edges.forEach((e, i) => {
      const lanes = Math.max(1, net.edgeLanes[e]);
      const s = net.edgeLen[e] - net.stopOff[e];
      const rev = net.edgeRev[e] >= 0;
      const lat = rev ? (lanes * LANE_W) / 2 : 0;
      net.pointAt(e, s, lat, p);
      q.setFromAxisAngle(this.yAxis, p.h);
      m.compose(new THREE.Vector3(p.x, 0.5, -p.y), q, new THREE.Vector3(0.9, 1, lanes * LANE_W));
      this.sigMesh.setMatrixAt(i, m);
      this.sigMesh.setColorAt(i, new THREE.Color(0x3bff7a));
    });
    this.sigMesh.count = edges.length;
    this.sigMesh.instanceMatrix.needsUpdate = true;
    this.sigMesh.renderOrder = 5;
  }

  private buildStops() {
    const stops = this.sim.data.stops;
    const g = new THREE.CylinderGeometry(5, 5, 2, 12);
    g.translate(0, 1, 0);
    this.stopMesh = this.inst(g, new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, stops.length));
    stops.forEach((s, i) => {
      this.tmpM.makeTranslation(s.x, 0.2, -s.y);
      this.stopMesh.setMatrixAt(i, this.tmpM);
      this.stopMesh.setColorAt(i, new THREE.Color(s.mode === 'tram' ? 0xff5a4a : 0xffb02e));
    });
    this.stopMesh.count = stops.length;
    this.stopMesh.instanceMatrix.needsUpdate = true;
    if (this.stopMesh.instanceColor) this.stopMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------------ view
  setMode(m: ViewMode) {
    this.mode = m;
    const prevTarget = this.controls ? this.controls.target.clone() : new THREE.Vector3();
    const cam = m === '2d' ? this.ortho : this.persp;
    this.camera = cam;
    this.controls.object = cam;
    if (m === '2d') {
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      this.ortho.position.set(prevTarget.x, 3000, prevTarget.z);
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = 0;
      this.controls.target.copy(prevTarget);
      this.ortho.lookAt(prevTarget);
      this.setBuildingsFlat(true);
      this.scene.fog = null;
    } else {
      this.controls.enableRotate = true;
      this.controls.screenSpacePanning = false;
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      this.controls.minPolarAngle = 0.05;
      this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
      this.persp.position.set(prevTarget.x + 380, 330, prevTarget.z + 520);
      this.controls.target.copy(prevTarget);
      this.persp.lookAt(prevTarget);
      this.setBuildingsFlat(false);
      this.scene.fog = new THREE.Fog(this.dark ? 0x0e1117 : 0xcfd8e6, 1800, 6500);
    }
    this.controls.minDistance = 20;
    this.controls.maxDistance = 6000;
    this.controls.update();
    this.resize();
  }

  private setBuildingsFlat(flat: boolean) {
    // in 2D the buildings are squashed so that roads and traffic stay readable
    this.buildingsMesh.scale.y = flat ? 0.06 : 1;
    this.buildingsMesh.position.y = flat ? 0.0 : 0;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const s = this.viewSize / 2;
    const a = w / h;
    this.ortho.left = -s * a; this.ortho.right = s * a; this.ortho.top = s; this.ortho.bottom = -s;
    this.ortho.updateProjectionMatrix();
  }

  setDark(dark: boolean) {
    this.dark = dark;
    const bg = dark ? 0x0e1117 : 0xe9edf3;
    (this.scene.background as THREE.Color).setHex(bg);
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.setHex(bg);
    this.hemi.intensity = dark ? 0.85 : 1.05;
  }

  setBuildingsVisible(v: boolean) {
    this.buildingsMesh.visible = v;
  }

  // ------------------------------------------------------------------ per-frame
  update(now: number) {
    const sim = this.sim, eng = sim.eng, net = sim.net;
    const P = this.pose;
    const m = this.tmpM, q = this.tmpQ, sc = this.tmpS, p = this.tmpP, col = this.tmpC;
    let nc = 0, nb = 0, nbus = 0, nt = 0;
    const veh = eng.vehicles;
    // keep traffic readable when zoomed out: grow markers so they stay a few pixels wide
    let vs = 1, ps = 1;
    if (this.mode === '2d') {
      const ppm = (this.canvas.clientHeight / this.viewSize) * this.ortho.zoom;
      vs = Math.min(10, Math.max(1, 5.5 / (ppm * 1.85)));
      ps = Math.min(40, Math.max(1, 5 / (ppm * 0.56)));
    } else {
      const dist = this.camera.position.distanceTo(this.controls.target);
      vs = Math.max(1, dist / 700);
      ps = Math.max(1, dist / 300);
    }
    const cm = this.carMesh, bm = this.bikeMesh, busm = this.busMesh, tm = this.tramMesh;
    for (let i = 0; i < veh.length; i++) {
      const v = veh[i];
      eng.pose(v, P);
      q.setFromAxisAngle(this.yAxis, P.h);
      v.x = P.x; v.y = P.y; v.h = P.h;
      if (v.type === VT_CAR) {
        if (nc >= MAX_CARS) continue;
        p.set(P.x, 0.12, -P.y);
        sc.set(v.len * Math.min(vs * 1.4, 4), 1.5 * Math.min(vs, 2.5), 1.85 * vs);
        m.compose(p, q, sc);
        cm.setMatrixAt(nc, m);
        if (this.vehicleColorMode === 'speed') {
          const lim = Math.max(3, Math.min(net.edgeSpeed[v.edge], 16));
          const r = Math.min(1, v.v / lim);
          if (r < 0.5) this.mix(this.cA, this.cB, r * 2, col); else this.mix(this.cB, this.cC, (r - 0.5) * 2, col);
        } else col.setHex(0xe8edf6);
        cm.setColorAt(nc, col);
        nc++;
      } else if (v.type === VT_BIKE) {
        if (nb >= MAX_BIKES) continue;
        p.set(P.x, 0.1, -P.y);
        sc.set(1.8 * vs, 1.4 * vs, 0.6 * vs);
        m.compose(p, q, sc);
        bm.setMatrixAt(nb, m);
        col.setHex(0x33d6c4);
        bm.setColorAt(nb, col);
        nb++;
      } else if (v.type === VT_BUS) {
        if (nbus >= MAX_BUSES) continue;
        p.set(P.x, 0.12, -P.y);
        sc.set(v.len, 3.0 * Math.min(vs, 2), 2.5 * vs);
        m.compose(p, q, sc);
        busm.setMatrixAt(nbus, m);
        col.setHex(0xffa726);
        busm.setColorAt(nbus, col);
        nbus++;
      } else {
        if (nt >= MAX_TRAMS) continue;
        p.set(P.x, 0.2, -P.y);
        sc.set(v.len, 3.4 * Math.min(vs, 2), 2.4 * vs);
        m.compose(p, q, sc);
        tm.setMatrixAt(nt, m);
        col.set(v.line?.data?.color || '#e2001a');
        tm.setColorAt(nt, col);
        nt++;
      }
    }
    cm.count = nc; bm.count = nb; busm.count = nbus; tm.count = nt;
    for (const mesh of [cm, bm, busm, tm]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    // pedestrians
    let np = 0;
    const peds = sim.peds.peds;
    const pm = this.pedMesh;
    const pp = { x: 0, y: 0, h: 0 };
    for (let i = 0; i < peds.length && np < MAX_PEDS; i++) {
      const pd = peds[i];
      if (pd.state === PS_RIDING || pd.state === PS_WAITSTOP && false) continue;
      if (pd.state === PS_WAITSTOP) {
        const st = sim.data.stops[pd.waitStopId];
        if (!st) continue;
        pp.x = st.x + ((pd.id * 37) % 7) - 3; pp.y = st.y + ((pd.id * 91) % 7) - 3;
      } else {
        sim.peds.poseAt(pd, pp);
      }
      pd.x = pp.x; pd.y = pp.y;
      p.set(pp.x, 0.1, -pp.y);
      q.identity();
      sc.set(ps, Math.min(ps, 3), ps);
      m.compose(p, q, sc);
      pm.setMatrixAt(np, m);
      if (pd.state === 1) col.setHex(0xff6b6b); else if (pd.state === PS_CROSSING) col.setHex(0xffd166); else if (pd.state === PS_WAITSTOP) col.setHex(0xb892ff); else col.setHex(0xf4f6fb);
      pm.setColorAt(np, col);
      np++;
    }
    pm.count = np;
    pm.instanceMatrix.needsUpdate = true;
    if (pm.instanceColor) pm.instanceColor.needsUpdate = true;

    // signals
    const st = sim.sig.status;
    for (let i = 0; i < this.sigEdges.length; i++) {
      const s = st[this.sigEdges[i]];
      col.setHex(s === 1 ? 0x2ee66b : s === 2 ? 0xffc02e : 0xff3b3b);
      this.sigMesh.setColorAt(i, col);
    }
    if (this.sigMesh.instanceColor) this.sigMesh.instanceColor.needsUpdate = true;

    // heat map
    if (this.roadColorMode !== 'class' && now - this.lastHeat > 1000) {
      this.lastHeat = now;
      this.updateHeat();
    }
    this.updateFollow();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private mix(a: THREE.Color, b: THREE.Color, t: number, out: THREE.Color) {
    out.r = a.r + (b.r - a.r) * t; out.g = a.g + (b.g - a.g) * t; out.b = a.b + (b.b - a.b) * t;
  }

  setRoadColorMode(mode: RoadColorMode) {
    this.roadColorMode = mode;
    if (mode === 'class') this.resetRoadColors();
    else this.updateHeat();
  }

  private resetRoadColors() {
    const net = this.sim.net, d = this.sim.data;
    const col = new THREE.Color();
    for (const c of this.roadCanon) {
      const s = this.edgeVerts[c];
      const tunnel = (d.edges[c].flags & F_TUNNEL) !== 0;
      col.setHex(tunnel ? 0x262a35 : CLASS_COLORS[Math.min(7, d.edges[c].cls)]);
      for (let i = 0; i < this.edgeVertN[c]; i++) this.roadColors.setXYZ(s + i, col.r, col.g, col.b);
    }
    void net;
    this.roadColors.needsUpdate = true;
  }

  private updateHeat() {
    const net = this.sim.net, eng = this.sim.eng;
    const col = new THREE.Color();
    const t = this.roadColorMode;
    for (const c of this.roadCanon) {
      const s = this.edgeVerts[c];
      const rev = net.edgeRev[c];
      let ratio = 1;
      if (t === 'speed') {
        const a = eng.edgeSpeedEma[c] / Math.max(2, net.edgeSpeed[c]);
        const b = rev >= 0 ? eng.edgeSpeedEma[rev] / Math.max(2, net.edgeSpeed[rev]) : a;
        ratio = Math.min(a, b);
        ratio = Math.max(0, Math.min(1, (ratio - 0.1) / 0.8));
      } else {
        const st = eng.stopTime[c] + (rev >= 0 ? eng.stopTime[rev] : 0);
        ratio = 1 - Math.min(1, st / (net.edgeLen[c] * 1.2 + 200));
      }
      if (ratio < 0.5) this.mix(this.cA, this.cB, ratio * 2, col); else this.mix(this.cB, this.cC, (ratio - 0.5) * 2, col);
      col.multiplyScalar(0.8);
      for (let i = 0; i < this.edgeVertN[c]; i++) this.roadColors.setXYZ(s + i, col.r, col.g, col.b);
    }
    this.roadColors.needsUpdate = true;
  }

  // ------------------------------------------------------------------ interaction
  /** world position (map coords) under the pointer */
  pick(ndcX: number, ndcY: number): { x: number; y: number } | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  setClosedEdges(edges: number[]) {
    const net = this.sim.net;
    const pos: number[] = [];
    for (const e of edges) {
      const p = net.edgePts[e];
      for (let i = 0; i + 3 < p.length; i += 2) pos.push(p[i], 1.5, -p[i + 1], p[i + 2], 1.5, -p[i + 3]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.closedMesh.geometry.dispose();
    const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff3b3b }));
    this.scene.remove(this.closedMesh);
    this.closedMesh = ls as unknown as THREE.Line;
    this.scene.add(this.closedMesh);
  }

  setFollow(f: World['follow']) {
    this.follow = f;
    if (f && this.mode === '3d') {
      this.controls.minDistance = 8;
    }
  }

  private updateFollow() {
    const f = this.follow;
    if (!f) return;
    let x: number, y: number;
    if (f.kind === 'veh') {
      if (!f.v.alive) { this.follow = null; return; }
      x = f.v.x; y = f.v.y;
    } else {
      x = f.p.x; y = f.p.y;
    }
    const target = this.controls.target;
    const dx = x - target.x, dz = -y - target.z;
    target.x += dx; target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
  }

  flyTo(x: number, y: number, dist = 400) {
    const t = this.controls.target;
    const dx = x - t.x, dz = -y - t.z;
    t.x += dx; t.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
    if (this.mode === '3d') {
      const dir = this.camera.position.clone().sub(t).normalize();
      this.camera.position.copy(t).addScaledVector(dir, dist);
    } else {
      this.ortho.zoom = Math.max(0.4, Math.min(8, this.viewSize / (dist * 2)));
      this.ortho.updateProjectionMatrix();
    }
  }
}
