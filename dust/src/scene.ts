import * as THREE from 'three';

// Everything specific to THIS scene lives here, so swapping in a new world is a
// one-file edit. The dust's own "feel" constants live in src/dust.ts.

/** A world-space point. Kept local so the app has no math-library dependency. */
export type Vec3 = [number, number, number];

// --- Assets (served from public/) ---
const BASE = import.meta.env.BASE_URL;
// LOD-encoded Spark asset (built by `pnpm build:lod` from assets/greenhouse.spz).
// The .rad format is what makes the paging budget in src/performance.ts mean
// anything — a flat .spz has no cheaper version of anything to fall back to, so
// every splat is resident and drawn every frame however the budget is set.
export const SPLAT_URL = `${BASE}greenhouse-lod.rad`;

// This splat is authored small; scaling it up gives the dust room to work at
// sensible world-unit sizes instead of thousandths.
export const SPLAT_SCALE = 3;

// --- Camera framing (world-space) — the orbit camera's start pose ---
export const CAMERA_POSITION: Vec3 = [0, 4, 2];
export const CAMERA_TARGET: Vec3 = [0, 2.5, -6];

// --- The volume the dust fills (world-space) ---
// Dust only needs to exist where the camera can see it, so this is the interior
// rather than the whole model — motes outside the glass would be wasted splats.
export const DUST_BOX = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 9, 10));
