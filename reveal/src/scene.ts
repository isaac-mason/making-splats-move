// Everything specific to THIS capture, so swapping in another world is a one-file
// edit. The reveal's own feel constants live in reveal.ts.

export type Vec3 = [number, number, number];

const BASE = import.meta.env.BASE_URL;
/** Shared with wind/ through vite.config.ts's publicDir — see the note there. */
export const SPLAT_URL = `${BASE}anime-city-lod.rad`;

export const CAMERA_POSITION: Vec3 = [0.52, 2.28, 1.07];
export const CAMERA_TARGET: Vec3 = [3.23, 7.22, -9.35];

/** The point everything grows out of. */
export const REVEAL_ORIGIN: Vec3 = [3.23, 7.22, -9.35];
