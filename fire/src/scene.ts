export type Vec3 = [number, number, number];

import campfireUrl from '../assets/campfire.spz?url';

export const SPLAT_URL = campfireUrl;

export const CAMERA_POSITION: Vec3 = [-0.77, 0.655, -1.58];
export const CAMERA_TARGET: Vec3 = [-0.06, 0.45, -7.64];

// From the debug raycast, nudged 0.12 m toward the camera onto the front of the log pile.
export const FIRE_ORIGIN: Vec3 = [-0.075, 0.3, -7.52];
export const FLAME_ORIGIN: Vec3 = [-0.075, 0.3, -7.52];
export const SPARK_ORIGIN: Vec3 = [-0.075, 0.4, -7.52];

export const FIREFLY_NEAR: Vec3 = [1.5, 1.59, -23.52];
export const FIREFLY_EXTENT: Vec3 = [16, 1.8, 22];
export const FIREFLY_BACK_WIDTH = 40;
