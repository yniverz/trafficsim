// Shared data model for the processed network (data/karlsruhe.json) and the simulation.

export type EdgeMode = 'road' | 'tram' | 'walk';

// Edge flag bits
export const F_CAR = 1;
export const F_BIKE = 2;
export const F_WALK = 4;
export const F_ONEWAY = 8;
export const F_TUNNEL = 16;
export const F_BRIDGE = 32;
export const F_ROUNDABOUT = 64;
export const F_BIKEINFRA = 128; // painted/separated bike lane exists
export const F_PEDZONE = 256;

export interface NetNodeData {
  x: number;
  y: number; // metres, +x east, +y north, origin = Marktplatz
  signal: number; // 1 = traffic signals
  cross: number; // 0 none, 1 uncontrolled crossing, 2 zebra, 3 signalised crossing
  gate: number; // 1 = map boundary entry/exit
}

export interface NetEdgeData {
  from: number;
  to: number;
  mode: EdgeMode;
  pts: number[]; // flat x,y polyline
  speed: number; // m/s limit
  lanes: number; // car lanes in this direction (0 for bike/walk only)
  cls: number; // road class 0..7
  flags: number;
  rev: number; // reverse directed edge id or -1
  name: number; // index into names, -1 none
}

export interface BuildingData {
  pts: number[];
  h: number; // metres
  kind: number; // 0 mixed/unknown, 1 residential, 2 work, 3 retail, 4 education, 5 health/other public
  tri?: number[]; // roof triangulation, indices into the footprint ring (without the closing duplicate)
}

export interface PoiData {
  x: number;
  y: number;
  kind: number; // 1 shop, 2 food, 3 leisure, 4 education, 5 health, 6 market
}

export interface StopData {
  id: number;
  name: string;
  mode: 'tram' | 'bus';
  edge: number; // directed edge on which vehicles halt
  s: number; // metres from the edge start (front of vehicle)
  x: number;
  y: number;
  walkEdge: number; // walk-capable edge for pedestrian access
  walkS: number;
}

export interface LineData {
  id: number;
  ref: string;
  name: string;
  mode: 'tram' | 'bus';
  route: number[]; // directed edge ids
  stops: { routeIdx: number; stop: number }[]; // stops in order along route
  headway: number[]; // seconds: [peak, day, evening, early]
  color: string;
}

export interface NetworkData {
  origin: { lat: number; lon: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  names: string[];
  nodes: NetNodeData[];
  edges: NetEdgeData[];
  buildings: BuildingData[];
  pois: PoiData[];
  stops: StopData[];
  lines: LineData[];
}
