/**
 * Everything specific to THIS capture, so swapping in another world is a one-file
 * edit. The effects' own look stays in their files.
 */

/** A world-space point. Kept local so the app has no math-library dependency. */
export type Vec3 = [number, number, number];

import campfireUrl from '../assets/campfire.spz?url';

// The flat capture. Radix reads .rad files but doesn't select LoD subsets or page
// them in yet, so the LoD build (public/campfire-lod.rad) has nothing to gain here:
// every splat draws every frame either way.
export const SPLAT_URL = campfireUrl;

export const CAMERA_POSITION: Vec3 = [-0.83, 0.67, -1.09];
export const CAMERA_TARGET: Vec3 = [-0.06, 0.45, -7.64];

// Measured with the debug raycast (backtick, click, read `hit`).
/** The firepit: drives the lighting and heat shimmer. */
export const FIRE_ORIGIN: Vec3 = [-0.06, 0.3, -7.64];
/** The log pile the flame and smoke rise from. */
export const FLAME_ORIGIN: Vec3 = [-0.06, 0.3, -7.64];
/** Where embers leave the fire. */
export const SPARK_ORIGIN: Vec3 = [-0.06, 0.4, -7.64];

/**
 * The fireflies' wedge: front-centre, then width, height and depth back into the
 * trees (-z). It flares to BACK_WIDTH at the far end.
 */
export const FIREFLY_NEAR: Vec3 = [1.5, 1.59, -23.52];
export const FIREFLY_EXTENT: Vec3 = [16, 1.8, 22];
export const FIREFLY_BACK_WIDTH = 40;
