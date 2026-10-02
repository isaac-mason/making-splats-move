// Everything specific to THIS capture, so swapping in another world is a one-file
// edit. The avatars' own numbers live in avatar-params.ts.

/** A world-space point. Kept local so the app has no math-library dependency. */
export type Vec3 = [number, number, number];

const BASE = import.meta.env.BASE_URL;
// LOD-paged build of assets/school-courtyard.spz (`pnpm build:lod`).
export const SPLAT_URL = `${BASE}school-courtyard-lod.rad`;

// This capture happens to arrive at very nearly the avatars' own scale — a park
// bench comes up to about their shoulders. A splat's units are whatever the capture decided they
// were, so check rather than assume for any other asset.
export const SPLAT_SCALE = 1;
export const SPLAT_OFFSET: Vec3 = [0, 0, 0];

// From the east lawn, looking across the crowd to the trees on the west side.
export const CAMERA_POSITION: Vec3 = [10.63, 3.8, -13.23];
export const CAMERA_TARGET: Vec3 = [-12.34, -0.72, 5.89];

// The camera's view direction on the ground, and its right. Several things below
// are laid out relative to where the camera looks, so moving it carries them along.
const VIEW_X = CAMERA_TARGET[0] - CAMERA_POSITION[0];
const VIEW_Z = CAMERA_TARGET[2] - CAMERA_POSITION[2];
const VIEW_LEN = Math.hypot(VIEW_X, VIEW_Z);
const FORWARD: [number, number] = [VIEW_X / VIEW_LEN, VIEW_Z / VIEW_LEN];
/** Forward turned a quarter clockwise, seen from above. */
const RIGHT: [number, number] = [-FORWARD[1], FORWARD[0]];

/** A tree for the wind: its canopy as a sphere. Sway grows from the sphere's base up. */
export type Tree = { center: Vec3; radius: number };

// The two big trees on the west lawn. A raycast lands on the FAR side of a crown
// as often as the near one, so these are centred on the canopies as seen from
// above (\`?sway\` tints what they catch), not on the measured hits.
export const TREES: Tree[] = [
    { center: [-21.0, 7.4, 5.21], radius: 5.3 },
    { center: [-22.0, 7.2, -4.74], radius: 5.3 },
];

// The main building is at +z (its steps at z ≈ 4), with wings down both sides and
// the lawn running north to z ≈ -23; a row of benches lines the west side of the
// path at x ≈ -3, and walkers don't collide with the scenery.
// A touch above the paving's own splats, which are soft and have depth: stand feet at
// exactly 0 and the soles sink into the stone. Raises the physics floor and where the
// walkers stand together, so fallen ones lie at the same height they walk at.
export const GROUND_Y = 0.03;

// The walk area: a rectangle turned to FACE THE CAMERA, so it's a band across the
// shot rather than a box at an angle to it. `across` runs left-right on screen,
// `deep` into it. Kept east of the benches. `?bounds` draws it — use it before
// moving these.
export const WALK_CENTER: Vec3 = [2.5, 0, -5.5];
export const WALK_HALF_ACROSS = 5;
export const WALK_HALF_DEEP = 2.5;
/** The walk area's axes on the ground: the camera's right and forward. */
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

// Where a walker goes to be customized, and the camera that looks at them.
//
// The camera is straight below the scene camera, so going in to customize is a drop
// rather than a pull back. The spot is DERIVED from it — a few metres along the
// view, shifted to the camera's left so the subject sits left of centre, clear of
// the editor panel — so moving the scene camera can't strand the subject off-screen.
// Check it's outside the walk area, or walkers wander between camera and subject.
/** How far in front of the camera the subject stands, and how far left of centre. */
const SHOWCASE_DISTANCE = 3.55;
const SHOWCASE_LEFT = 0.75;
export const SHOWCASE_CAMERA: Vec3 = [CAMERA_POSITION[0], 1.5, CAMERA_POSITION[2]];
export const SHOWCASE_SPOT: Vec3 = [
    SHOWCASE_CAMERA[0] + FORWARD[0] * SHOWCASE_DISTANCE - RIGHT[0] * SHOWCASE_LEFT,
    0,
    SHOWCASE_CAMERA[2] + FORWARD[1] * SHOWCASE_DISTANCE - RIGHT[1] * SHOWCASE_LEFT,
];
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
