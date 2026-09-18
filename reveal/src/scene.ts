// Everything specific to THIS capture, so swapping in another world is a one-file
// edit. The reveal's own feel constants live in reveal.ts.

export type Vec3 = [number, number, number];

const BASE = import.meta.env.BASE_URL;
/** Shared with wind/ through vite.config.ts's publicDir — see the note there. */
export const SPLAT_URL = `${BASE}anime-city-lod.rad`;

export const CAMERA_POSITION: Vec3 = [0.52, 2.28, 1.07];
export const CAMERA_TARGET: Vec3 = [3.23, 7.22, -9.35];

/**
 * Sky behind everything, and what unrevealed space looks like.
 *
 * Close to the blue the capture's own sky splats already are, so the front of the
 * ripple reads as a hard edge on the buildings rather than on the sky.
 */
export const SKY = 0x59b3f4;

/** The point the ripple spreads out from. */
export const REVEAL_ORIGIN: Vec3 = [3.23, 7.22, -9.35];
