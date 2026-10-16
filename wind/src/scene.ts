// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; per-system "feel"
// constants (sway amplitude, speed, …) stay in their own files.

import cityUrl from '../assets/anime-city.spz?url';

/** A world-space point. Kept local so the app has no math-library dependency. */
export type Vec3 = [number, number, number];

// The flat capture: radix draws every splat every frame, so there's no LoD build.
export const SPLAT_URL = cityUrl;

// --- Camera framing (world-space) — the orbit camera's start pose ---
export const CAMERA_POSITION: Vec3 = [0.52, 2.28, 1.07];
export const CAMERA_TARGET: Vec3 = [3.23, 7.22, -9.35];
