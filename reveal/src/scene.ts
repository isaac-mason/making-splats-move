// Everything specific to THIS capture, so swapping in another world is a one-file
// edit. The reveal's own feel constants live in reveal.ts.

import cityUrl from '../../wind/assets/anime-city.spz?url';

export type Vec3 = [number, number, number];

/**
 * The flat capture, shared with wind/ (a second 66MB copy would be 66MB of nothing).
 * Radix reads the LoD build too but selects no LoD subsets and pages nothing in, so
 * the flat file is the whole download the reveal waits on.
 */
export const SPLAT_URL = cityUrl;

export const CAMERA_POSITION: Vec3 = [11.05, 3.6, -2.29];
export const CAMERA_TARGET: Vec3 = [8.11, 3.66, -2.53];

/**
 * Sky behind everything, and what unrevealed space looks like.
 *
 * Close to the blue the capture's own sky splats already are, so the front of the
 * ripple reads as a hard edge on the buildings rather than on the sky.
 */
export const SKY = 0x59b3f4;

/** The point the ripple spreads out from. */
export const REVEAL_ORIGIN: Vec3 = [3.23, 7.22, -9.35];
