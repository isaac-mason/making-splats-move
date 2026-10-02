/**
 * Everything specific to THIS capture, so swapping in another world is a one-file
 * edit. The avatars' own numbers live in avatar-params.ts.
 */

/** A world-space point. */
export type Vec3 = [number, number, number];

const BASE = import.meta.env.BASE_URL;
// LOD-paged build of assets/school-courtyard.spz (`pnpm build:lod`).
export const SPLAT_URL = `${BASE}school-courtyard-lod.rad`;

// This capture arrives at about the avatars' scale. Another may not: check.
export const SPLAT_SCALE = 1;
export const SPLAT_OFFSET: Vec3 = [0, 0, 0];

// From the east lawn, looking across the crowd to the trees on the west side.
export const CAMERA_POSITION: Vec3 = [10.63, 3.8, -13.23];
export const CAMERA_TARGET: Vec3 = [-12.34, -0.72, 5.89];

// The camera's forward and right on the ground. The walk area and the showcase are
// laid out from them, so moving the camera carries them along.
const VIEW_X = CAMERA_TARGET[0] - CAMERA_POSITION[0];
const VIEW_Z = CAMERA_TARGET[2] - CAMERA_POSITION[2];
const VIEW_LEN = Math.hypot(VIEW_X, VIEW_Z);
const FORWARD: [number, number] = [VIEW_X / VIEW_LEN, VIEW_Z / VIEW_LEN];
const RIGHT: [number, number] = [-FORWARD[1], FORWARD[0]];

/** A tree's canopy as a sphere. Sway grows from its base up. */
export type Tree = { center: Vec3; radius: number };

// The two big trees on the west lawn, centred by eye ('tint sway' in the debug
// panel shows what they catch): a raycast lands on a crown's far side as often as not.
export const TREES: Tree[] = [
    { center: [-21.0, 7.4, 5.21], radius: 5.3 },
    { center: [-22.0, 7.2, -4.74], radius: 5.3 },
];

// A touch above the paving, whose splats are soft and have depth: at exactly 0 the
// soles sink in. The physics floor uses it too, so the fallen lie where they walked.
export const GROUND_Y = 0.03;

// The walk area: a rectangle turned to face the camera, so it's a band across the
// shot. `across` runs left-right on screen, `deep` into it. Walkers don't collide
// with the scenery, so it's kept clear of the benches — 'show walk bounds' in the
// debug panel draws it.
export const WALK_CENTER: Vec3 = [2.5, 0, -5.5];
export const WALK_HALF_ACROSS = 5;
export const WALK_HALF_DEEP = 2.5;
export const WALK_ACROSS = RIGHT;
export const WALK_DEEP = FORWARD;

/** A ground point in the walk area's frame: [across, deep] from its centre. */
export function walkLocal(x: number, z: number): [number, number] {
    const dx = x - WALK_CENTER[0];
    const dz = z - WALK_CENTER[2];
    return [dx * WALK_ACROSS[0] + dz * WALK_ACROSS[1], dx * WALK_DEEP[0] + dz * WALK_DEEP[1]];
}

/** Back from the walk area's frame to the ground: [x, z]. */
export function walkWorld(across: number, deep: number): [number, number] {
    return [
        WALK_CENTER[0] + WALK_ACROSS[0] * across + WALK_DEEP[0] * deep,
        WALK_CENTER[2] + WALK_ACROSS[1] * across + WALK_DEEP[1] * deep,
    ];
}

// Where a walker goes to be customized. The camera drops straight down from the
// scene camera, and the spot is derived from it — in front, and left of centre to
// clear the editor panel — so moving the camera can't strand the subject. Keep it
// outside the walk area, or walkers wander into the shot.
const SHOWCASE_DISTANCE = 3.55;
const SHOWCASE_LEFT = 0.75;
export const SHOWCASE_CAMERA: Vec3 = [CAMERA_POSITION[0], 1.5, CAMERA_POSITION[2]];
export const SHOWCASE_SPOT: Vec3 = [
    SHOWCASE_CAMERA[0] + FORWARD[0] * SHOWCASE_DISTANCE - RIGHT[0] * SHOWCASE_LEFT,
    0,
    SHOWCASE_CAMERA[2] + FORWARD[1] * SHOWCASE_DISTANCE - RIGHT[1] * SHOWCASE_LEFT,
];
/** Aim height above the spot: mid-chest. They're ~2.2m, far taller than they look. */
export const SHOWCASE_LOOK_Y = 1.15;
export const SHOWCASE_FACING = Math.atan2(SHOWCASE_CAMERA[0] - SHOWCASE_SPOT[0], SHOWCASE_CAMERA[2] - SHOWCASE_SPOT[2]);
