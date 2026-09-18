// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; per-system "feel"
// constants (sway amplitude, speed, …) stay in their own files.

/** A world-space point. Kept local so the app has no math-library dependency. */
export type Vec3 = [number, number, number];

// --- Assets (served from public/; see the README's asset pipeline) ---
// BASE_URL is '/' in dev and '/<base>/' when BASE_PATH is set for a subpath deploy
// (vite.config.ts), so this resolves either way.
const BASE = import.meta.env.BASE_URL;
// LOD-encoded Spark asset (built by `pnpm build:lod` from a source .spz). The .rad
// format is what makes Spark's LOD/paging budget (src/performance.ts) actually take
// effect — a flat .spz renders all splats every frame.
export const SPLAT_URL = `${BASE}anime-city-lod.rad`;

// --- Camera framing (world-space) — the orbit camera's start pose ---
export const CAMERA_POSITION: Vec3 = [0.52, 2.28, 1.07];
export const CAMERA_TARGET: Vec3 = [3.23, 7.22, -9.35];
