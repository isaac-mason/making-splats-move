// Everything specific to THIS capture, so swapping in another world is a one-file
// edit. The avatars' own numbers live in avatar-params.ts.

/** A world-space point. Kept local so the app has no math-library dependency. */
export type Vec3 = [number, number, number];

const BASE = import.meta.env.BASE_URL;
export const SPLAT_URL = `${BASE}town-hall.spz`;

// This capture happens to arrive at very nearly the avatars' own scale — a door is
// about two of them tall. A splat's units are whatever the capture decided they
// were, so check rather than assume for any other asset.
export const SPLAT_SCALE = 1;
export const SPLAT_OFFSET: Vec3 = [0, 0, 0];

export const CAMERA_POSITION: Vec3 = [-0.5, 3.76, -1.08];
export const CAMERA_TARGET: Vec3 = [-0.44, 2.59, -3.67];

// The town hall is at -z and the capture peters out toward +z, where the
// photographer stood; crowd and camera both have to stay this side of that edge or
// they end up in the void. `?bounds` draws the box — use it before moving these.
export const GROUND_Y = 0;
export const WALK_CENTER: Vec3 = [-0.48, 0, -11.18];
export const WALK_BOUNDS_X = 3.8;
export const WALK_BOUNDS_Z = 3.5;

// Where a walker goes to be customized, and the camera that looks at them.
export const SHOWCASE_SPOT: Vec3 = [-0.4, 0, -5.6];
/** Offset right of the subject: the editor panel takes the right third of the window. */
export const SHOWCASE_CAMERA: Vec3 = [0.35, 1.5, -2.05];
/**
 * Aim height above the spot, which is also what sets the tilt.
 *
 * Mid-chest on a ~2.2m figure — they're far taller than they look, since `headY` is
 * `hipY + torsoHeight + headRadius * headSit` with most of a metre of head on top.
 * Aim at human waist height and the camera points at the floor.
 */
export const SHOWCASE_LOOK_Y = 1.15;
/** Derived, so moving the spot or the camera can't leave the subject facing away. */
export const SHOWCASE_FACING = Math.atan2(SHOWCASE_CAMERA[0] - SHOWCASE_SPOT[0], SHOWCASE_CAMERA[2] - SHOWCASE_SPOT[2]);
