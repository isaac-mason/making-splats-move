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
// LOD-encoded Spark asset (built by `pnpm build:lod` from assets/campfire.spz).
// The .rad format is what makes Spark's LOD budget (src/performance.ts, and the
// debug panel's `lod scale` slider) actually take effect — a flat .spz renders
// every splat every frame no matter what the budget says.
export const SPLAT_URL = `${BASE}campfire-lod.rad`;

// --- Camera framing (world-space) ---
export const CAMERA_POSITION: Vec3 = [0, 0.5, 1];
export const CAMERA_TARGET: Vec3 = [-0.06, 0.45, -7.64];

// --- World landmarks (world-space) ---
export const FIRE_ORIGIN: Vec3 = [-0.06, 0.3, -7.64]; // the firepit — drives lighting, heat shimmer, dust
export const SPARK_ORIGIN: Vec3 = [-0.06, 0.4, -7.64]; // where embers leave the fire

// The log pile, measured with the debug raycast (backtick, then click a point and
// read the `hit` line). The stone ring is about 0.5 across with the logs at its
// centre, so the flame sits on top of them rather than inside anything.
export const FLAME_ORIGIN: Vec3 = [-0.06, 0.3, -7.64];
