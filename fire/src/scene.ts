/**
 * Everything specific to THIS capture, so swapping in another world is a one-file
 * edit. The effects' own look stays in their files.
 */

/** A world-space point. Kept local so the app has no math-library dependency. */
export type Vec3 = [number, number, number];

import campfireUrl from '../assets/campfire.spz?url';

// The flat capture: radix draws every splat every frame, so there's no LoD build.
export const SPLAT_URL = campfireUrl;

export const CAMERA_POSITION: Vec3 = [-0.77, 0.655, -1.58];
export const CAMERA_TARGET: Vec3 = [-0.06, 0.45, -7.64];

// Measured with the debug raycast (backtick, click, read `hit`), then nudged 0.12 m
// toward the camera so the flame sits on the front of the log pile.
/** The firepit: drives the lighting and heat shimmer. */
export const FIRE_ORIGIN: Vec3 = [-0.075, 0.3, -7.52];
/** The log pile the flame and smoke rise from. */
export const FLAME_ORIGIN: Vec3 = [-0.075, 0.3, -7.52];
/** Where embers leave the fire. */
export const SPARK_ORIGIN: Vec3 = [-0.075, 0.4, -7.52];

/**
 * The fireflies' wedge: front-centre, then width, height and depth back into the
 * trees (-z). It flares to BACK_WIDTH at the far end.
 */
export const FIREFLY_NEAR: Vec3 = [1.5, 1.59, -23.52];
export const FIREFLY_EXTENT: Vec3 = [16, 1.8, 22];
export const FIREFLY_BACK_WIDTH = 40;
