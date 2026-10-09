import type { Vehicle } from './engine';

export const MODE_WALK = 0;
export const MODE_BIKE = 1;
export const MODE_CAR = 2;
export const MODE_PT = 3;
export const MODE_NAMES = ['Walk', 'Bike', 'Car', 'Public transport'];

export const PURPOSE_WORK = 0;
export const PURPOSE_HOME = 1;
export const PURPOSE_SHOP = 2;
export const PURPOSE_LEISURE = 3;
export const PURPOSE_SCHOOL = 4;
export const PURPOSE_LUNCH = 5;
export const PURPOSE_THROUGH = 6;
export const PURPOSE_NAMES = ['Work', 'Home', 'Shopping', 'Leisure', 'School/Uni', 'Lunch', 'Through traffic'];

/** A location in the world with snapped positions on each network layer. */
export interface Place {
  x: number;
  y: number;
  walkC: number; // canonical walk edge
  walkS: number;
  carE: number; // road edge where cars start (or enter at a gate)
  carS: number;
  carEndE: number; // road edge where cars end (or exit at a gate)
  carEndS: number;
  bikeE: number;
  bikeS: number;
  gate: boolean;
  name?: string;
}

export interface Trip {
  depart: number; // seconds since 00:00
  from: Place;
  to: Place;
  mode: number;
  purpose: number;
}

export interface Agent {
  id: number;
  kind: number; // 0 worker 1 student 2 other 3 external commuter 4 through
  trips: Trip[];
  ti: number;
}

export type Leg =
  | { kind: 'walk'; arcs: number[]; sArc0: number; sEnd: number }
  | { kind: 'ride'; from: number; to: number; lineIds: number[] };

export const PS_WALK = 0;
export const PS_WAITCROSS = 1;
export const PS_CROSSING = 2;
export const PS_WAITSTOP = 3;
export const PS_RIDING = 4;

export class Ped {
  id = 0;
  agent!: Agent;
  trip!: Trip;
  legs: Leg[] = [];
  li = 0;
  arcs: number[] = [];
  ai = 0;
  s = 0; // along the current arc
  sEnd = 0; // limit on the last arc
  state = PS_WALK;
  speed = 1.35;
  waitingSince = 0;
  waitedTotal = 0;
  crossArms: any[] = [];
  crossNode = -1;
  crossT = 0;
  crossDur = 1;
  cx0 = 0; cy0 = 0;
  x = 0; y = 0; h = 0;
  vehicle: Vehicle | null = null;
  rideTo = -1;
  waitStopId = -1;
  boardWaitStart = 0;
  tDepart = 0;
  idealTime = 0; // expected door-to-door time without delay
  walkDist = 0;
  hidden = false;
}
