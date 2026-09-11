// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; the per-effect
// "feel" constants (fire swell, shimmer strength, particle counts, …) stay in
// their own system files, since they're the look you keep regardless of geometry.

/** A world-space point. Kept local so the app has no math-library dependency. */
export type Vec3 = [number, number, number];

// --- Assets (served from public/; see the README's asset pipeline) ---
// BASE_URL is '/' in dev and '/<base>/' when BASE_PATH is set for a subpath deploy
// (vite.config.ts), so this resolves either way.
const BASE = import.meta.env.BASE_URL;
export const SPLAT_URL = `${BASE}boiler-room-lod.rad`;

// --- Camera framing (world-space) ---
export const CAMERA_POSITION: Vec3 = [-0.5, 0.43, -0.66];
export const CAMERA_TARGET: Vec3 = [-0.8, 0.4, -2];

// --- World landmarks (world-space) ---
export const FIRE_ORIGIN: Vec3 = [-1.6, 0.09, -2.44]; // the fire — drives lighting, heat shimmer, dust
export const SPARK_ORIGIN: Vec3 = [-1.55, 0.2, -2.45]; // where embers leave the fire
