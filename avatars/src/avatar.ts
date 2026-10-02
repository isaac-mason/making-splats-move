/**
 * A procedural avatar: a small stylised character, built out of splats, rigged and
 * walking. Skeleton and geometry come from the same numbers, so rigging is free —
 * every splat knows which bone it belongs to.
 *
 * Reading order: building one (a builder per body part), posing it, handing the
 * pose to Spark, and last the shell — the splat-surface primitives the builders use.
 */

import { dyno as d, SplatMesh, SplatSkinning, SplatSkinningMode } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { type AvatarParams, DEFAULT_AVATAR } from './avatar-params';
import { type BoneDef, initSkeleton, poseSkeleton, pushSkeleton, type Skeleton, setBoneWorld, weightsForPoint } from './bones';

/* constants */

/* bones, in the order `measure` defines them */
export const PELVIS = 0;
const CHEST = 1;
export const HEAD = 2;
const ARM_L = 3;
const FORE_L = 4;
const ARM_R = 5;
const FORE_R = 6;
const THIGH_L = 7;
const SHIN_L = 8;
const THIGH_R = 9;
const SHIN_R = 10;
/** Not part of the skeleton: the pupils' own bone, riding the head. See `gaze`. */
const GAZE = SHIN_R + 1;
const BONE_COUNT = GAZE + 1;

/* faces */
/**
 * A face is made of PARTS (eyes, brows, mouth), and every variant of every part is
 * built into the mesh; an expression switches the unused ones off by opacity, so
 * changing face is a uniform write. Opacity rather than moving them out of sight:
 * Spark sorts asynchronously, so a part that jumps into place draws behind the skin
 * until the next sort lands.
 */
export const EXPRESSIONS = ['happy', 'blink', 'scared', 'dizzy'] as const;
export type Expression = (typeof EXPRESSIONS)[number];

const FACE_PARTS = [
    'eyesOpen',
    'eyesShut',
    'eyesWide',
    'eyesCrossed',
    'browsCalm',
    'browsWorried',
    'browsDizzy',
    'mouthSmile',
    'mouthO',
    'mouthWobble',
] as const;
type FacePart = (typeof FACE_PARTS)[number];

const EXPRESSION_PARTS: Record<Expression, readonly FacePart[]> = {
    happy: ['eyesOpen', 'browsCalm', 'mouthSmile'],
    blink: ['eyesShut', 'browsCalm', 'mouthSmile'],
    scared: ['eyesWide', 'browsWorried', 'mouthO'],
    dizzy: ['eyesCrossed', 'browsDizzy', 'mouthWobble'],
};

/** Width of the per-splat face-part lookup texture. */
const PART_TEX_WIDTH = 4096;

/* types */

export type Avatar = {
    params: AvatarParams;
    /** Height of the lowest splat. Measured, because the soles' depth depends on limbRadius. */
    feetY: number;
    mesh: SplatMesh;
    skinning: SplatSkinning;
    skeleton: Skeleton;
    /** Which face is showing. Set it freely; `pushAvatar` applies it. */
    expression: Expression;
    /** Bitmask of the FACE_PARTS showing, read by the mesh's modifier. */
    faceShowing: ReturnType<typeof d.dynoInt>;
    /** Where the eyes look, -1..1 each way: +x the avatar's own left (it faces +Z), +y up. */
    gaze: THREE.Vector2;
    /** How far the pupils can slide before leaving the whites, in metres. */
    gazeRange: THREE.Vector2;
    /** Extra head turn toward what they're looking at: yaw, pitch in radians. */
    look: THREE.Vector2;
    /** Not just `mesh.dispose()`: SplatSkinning's two GPU textures need releasing too. */
    dispose(): void;
};

type Body = ReturnType<typeof measure>;
type Palette = ReturnType<typeof palette>;
type HeadShape = ReturnType<typeof headShape>;

/** A run of splats, by index, and something about all of them. */
type Span = { start: number; end: number; value: number };

/** Everything a builder needs, plus the bookkeeping `pin` and `part` record into. */
type Build = {
    p: AvatarParams;
    shell: Shell;
    body: Body;
    color: Palette;
    head: HeadShape;
    /** Splats that follow one bone rigidly, instead of being weighted by distance. */
    pins: Span[];
    /** Splats that belong to a face part, for the visibility mask. */
    parts: Span[];
};

/** What a face feature supplies; `buildFace`'s decal helper fills in the rest. */
type FaceDecal = Omit<Parameters<typeof addDecal>[1], 'centre' | 'surface' | 'spacing' | 'owner'>;

function v(x: number, y: number, z: number) {
    return new THREE.Vector3(x, y, z);
}

/* building one */

export function initAvatar(params: AvatarParams = DEFAULT_AVATAR, seed = 1): Avatar {
    const p = params;
    const body = measure(p);
    const b: Build = {
        p,
        shell: createShell(seed, { overlap: p.overlap, jitter: p.jitter }),
        body,
        color: palette(p),
        head: headShape(p, body),
        pins: [],
        parts: [],
    };

    buildTorso(b);
    buildHead(b);
    buildHair(b);
    const gazeRange = buildFace(b);
    buildLimbs(b);

    const { mesh, skinning, partTexture, faceShowing } = toMesh(b);
    return {
        params: p,
        feetY: lowestPoint(b),
        mesh,
        skinning,
        skeleton: initSkeleton(body.bones),
        expression: 'happy',
        faceShowing,
        gaze: new THREE.Vector2(),
        gazeRange,
        look: new THREE.Vector2(),
        dispose() {
            partTexture.dispose();
            skinning.skinTexture.dispose();
            skinning.boneTexture.dispose();
            mesh.dispose();
        },
    };
}

/** Every splat added inside `add` follows `bone` rigidly. The innermost pin wins. */
function pin(b: Build, bone: number, add: () => void): void {
    const start = splatCount(b.shell);
    add();
    b.pins.push({ start, end: splatCount(b.shell), value: bone });
}

/** Every splat added inside `add` belongs to face part `name`. */
function part(b: Build, name: FacePart, add: () => void): void {
    const start = splatCount(b.shell);
    add();
    b.parts.push({ start, end: splatCount(b.shell), value: FACE_PARTS.indexOf(name) });
}

/* proportions and skeleton */
/** Big head, stubby everything else. */
function measure(p: AvatarParams) {
    const { headRadius, hipY, torsoWidth, armLength, limbRadius } = p;
    const shoulderY = hipY + p.torsoHeight;
    // No neck: the chin sits on the shoulder line (see `headSit`).
    const headY = shoulderY + headRadius * p.headSit;
    const shoulderX = torsoWidth * p.shoulderWidth * 0.92;
    const elbow = v(shoulderX + armLength * 0.36, shoulderY - armLength * 0.45, 0);
    const hand = v(shoulderX + armLength * 0.52, shoulderY - armLength * 0.95, 0);
    const kneeY = hipY * 0.52;
    const hipX = torsoWidth * 0.42;
    const waistY = (hipY + shoulderY) / 2;

    const bones: BoneDef[] = [
        { name: 'pelvis', parent: -1, head: v(0, hipY, 0), tail: v(0, waistY, 0), radius: torsoWidth },
        { name: 'chest', parent: PELVIS, head: v(0, waistY, 0), tail: v(0, shoulderY, 0), radius: torsoWidth },
        { name: 'head', parent: CHEST, head: v(0, shoulderY, 0), tail: v(0, headY + headRadius, 0), radius: headRadius * 0.9 },
        { name: 'armL', parent: CHEST, head: v(shoulderX, shoulderY - p.armDrop, 0), tail: elbow, radius: limbRadius * 1.5 },
        { name: 'foreL', parent: ARM_L, head: elbow, tail: hand, radius: limbRadius * 1.4 },
        {
            name: 'armR',
            parent: CHEST,
            head: v(-shoulderX, shoulderY - p.armDrop, 0),
            tail: v(-elbow.x, elbow.y, 0),
            radius: limbRadius * 1.5,
        },
        { name: 'foreR', parent: ARM_R, head: v(-elbow.x, elbow.y, 0), tail: v(-hand.x, hand.y, 0), radius: limbRadius * 1.4 },
        { name: 'thighL', parent: PELVIS, head: v(hipX, hipY, 0), tail: v(hipX, kneeY, 0), radius: limbRadius * 1.7 },
        { name: 'shinL', parent: THIGH_L, head: v(hipX, kneeY, 0), tail: v(hipX, 0.05, 0), radius: limbRadius * 1.5 },
        { name: 'thighR', parent: PELVIS, head: v(-hipX, hipY, 0), tail: v(-hipX, kneeY, 0), radius: limbRadius * 1.7 },
        { name: 'shinR', parent: THIGH_R, head: v(-hipX, kneeY, 0), tail: v(-hipX, 0.05, 0), radius: limbRadius * 1.5 },
    ];

    return {
        headRadius,
        hipY,
        shoulderY,
        headY,
        torsoWidth,
        limbRadius,
        shoulderX,
        elbow,
        hand,
        kneeY,
        hipX,
        waistY,
        crotchY: hipY - p.hemDrop - 0.04,
        hemY: hipY + p.hemDrop,
        bones,
    };
}

function palette(p: AvatarParams) {
    const skin = splatColor(p.skin);
    return {
        skin,
        shirt: splatColor(p.shirt),
        trousers: splatColor(p.trousers),
        hair: splatColor(p.hair),
        shoe: splatColor(p.shoes),
        pupil: splatColor(p.eyes),
        dark: splatColor('#1b1a20'),
        sclera: splatColor('#f8f5f1'),
        blush: skin.clone().lerp(splatColor('#ff7f93'), p.blushStrength),
    };
}

/** The head's shape, which the skull, the hair and the face all wrap onto. */
function headShape(p: AvatarParams, body: Body) {
    const r = body.headRadius;

    // An egg, not a sphere: the chin is what makes it a head.
    const taper = (uy: number) => 1 - p.chinTaper * Math.max(0, -uy) ** 1.5;

    // Whether the hair covers this direction: above the brows in front, past the ears
    // behind. `lift` raises the cut at the front only (see buildHead).
    const covers = (u: THREE.Vector3, lift = 0) => {
        const front = Math.max(0, u.z);
        const frontness = front * front;
        const cut = THREE.MathUtils.lerp(p.hairBackY, p.fringeY, frontness);
        const az = Math.atan2(u.x, Math.max(u.z, 1e-4));
        // A triangle wave, so the fringe is jagged rather than scalloped...
        const cycles = az * p.fringePoints * 0.55 + p.fringePhase;
        const tooth = 1 - 2 * Math.abs(cycles - Math.floor(cycles) - 0.5);
        // ...plus one slow sweep, for a parting.
        const sweep = p.fringeSweep * Math.sin(az + p.fringePhase);
        return u.y > cut + (lift - p.fringeDepth * tooth - sweep) * frontness;
    };

    // Distance to the skin along a direction, in headRadius, for the face decals to
    // wrap onto. The taper depends on where the point lands, so a few fixed-point steps.
    const radii = v(p.headWidth, p.headHeight, p.headDepth);
    const surface = (dir: THREE.Vector3) => {
        let uy = dir.y;
        let t = 1;
        for (let k = 0; k < 4; k++) {
            const s = taper(uy);
            const x = dir.x / (radii.x * s);
            const y = dir.y / radii.y;
            const z = dir.z / (radii.z * s);
            t = 1 / Math.sqrt(x * x + y * y + z * z);
            uy = THREE.MathUtils.clamp((t * dir.y) / radii.y, -1, 1);
        }
        return t;
    };

    return { centre: v(0, body.headY, 0), skull: v(r * p.headWidth, r * p.headHeight, r * p.headDepth), taper, covers, surface };
}

/* torso */
/** One lofted surface. Read down the `width` column and you can see the silhouette. */
function buildTorso(b: Build): void {
    const { p, body, color } = b;
    const w = body.torsoWidth;
    addLoft(b.shell, {
        profile: [
            // Down to the crotch, so shirt and trousers are one surface.
            { y: body.crotchY, width: w * 0.94, depth: w * 0.7 },
            { y: body.hipY - 0.02, width: w * 1.02, depth: w * 0.74 },
            { y: body.hipY + 0.05, width: w * 1.0, depth: w * 0.73 },
            { y: body.waistY, width: w * 1.0, depth: w * 0.72 },
            // The shoulders are the silhouette: narrow, and the arms look stuck on.
            { y: body.shoulderY - 0.11, width: w * 1.3, depth: w * 0.78 },
            { y: body.shoulderY - 0.02, width: w * p.shoulderWidth, depth: w * 0.76 },
            // ...then it falls away fast into the chin.
            { y: body.shoulderY + p.chestRise * 0.4, width: w * 0.82, depth: w * 0.62 },
            { y: body.shoulderY + p.chestRise, width: w * p.chestTaper, depth: w * p.chestTaper * 0.8 },
        ],
        roundness: p.torsoRoundness,
        spacing: p.spacing,
        colorAt: (y) => (y < body.hemY ? color.trousers : color.shirt),
        edges: [body.hemY],
        ownerAt: (y) => (y < body.waistY ? PELVIS : CHEST),
        layers: p.layers,
        capBottom: true,
    });
}

/* head */
/**
 * The skull, painted hair-coloured wherever the hair covers it, so gaps in the hair
 * don't show skin.
 */
function buildHead(b: Build): void {
    const { p, head, color } = b;
    // The hair is bigger than the skull, so seen from the front its edge sits higher:
    // lift the painted edge to match, or a band of scalp shows under the fringe.
    const SCALP_LIFT = 0.14;
    addSphere(b.shell, head.centre, b.body.headRadius, p.spacing, color.skin, HEAD, {
        layers: p.layers,
        radii: head.skull,
        taper: head.taper,
        keep: (u) => !head.covers(u, SCALP_LIFT),
    });
    // One layer: under the hair it only has to plug gaps.
    addSphere(b.shell, head.centre, b.body.headRadius, p.spacing, color.hair, HEAD, {
        radii: head.skull,
        taper: head.taper,
        keep: (u) => head.covers(u, SCALP_LIFT),
    });
}

/* hair */
function buildHair(b: Build): void {
    const { p, body, head, color } = b;
    const r = body.headRadius;
    const hairSpacing = p.spacing * p.hairSpacingScale;

    // A volume over the skull rather than paint on it, so it reads as a mass.
    addSphere(b.shell, head.centre, r, hairSpacing, color.hair, HEAD, {
        radii: head.skull.clone().multiplyScalar(p.hairThickness),
        taper: head.taper,
        keep: (u) => head.covers(u),
    });

    if (p.hairLength <= 0) return;

    // Long hair, in two pieces so it can't pass through the arms, both pinned so it
    // doesn't follow them. First a curtain round the sides and back, resting on the
    // shoulders, kept off the front so it frames the face.
    const top = body.headY + r * p.headHeight * p.hairThickness;
    const bottom = body.headY - r * (0.55 + p.hairLength);
    const armTop = body.shoulderY - p.armDrop + body.limbRadius * 1.5 + 0.03;
    // The ellipsoid runs past the cut, so the ends are blunt.
    const BLUNT = -0.78;
    const halfHeight = (top - Math.max(bottom, armTop)) / (1 - BLUNT);
    pin(b, HEAD, () =>
        addSphere(b.shell, v(0, top - halfHeight, -r * 0.04), r, hairSpacing, color.hair, HEAD, {
            layers: p.layers,
            radii: v(r * p.headWidth * p.hairThickness * 1.03, halfHeight, r * p.headDepth * p.hairThickness * 1.03),
            keep: (u) => u.y > BLUNT && u.z < 0.3,
        }),
    );

    // Anything longer hangs as a panel down the back, inside the arms' swing,
    // starting inside the curtain so the join is hidden.
    if (bottom >= armTop) return;
    const panelTop = armTop + r * 0.35;
    const panelHalf = (panelTop - bottom) / 1.8;
    pin(b, CHEST, () =>
        addSphere(b.shell, v(0, panelTop - panelHalf, -(body.torsoWidth * 0.78 + 0.07)), r, hairSpacing, color.hair, CHEST, {
            layers: p.layers,
            radii: v(body.torsoWidth * 1.05, panelHalf, 0.06),
            keep: (u) => u.y > -0.8,
        }),
    );
}

/* face */
/**
 * Every feature, as decals wrapped onto the head. Returns how far the pupils can
 * slide and stay inside the whites.
 *
 * Features stand proud of the skull and stack outward in layers, each a clear gap
 * above the last, so the sort can't put skin over a feature or swap two. The face is
 * pinned to the head: blended with the neck, it would shear as the head turns.
 */
function buildFace(b: Build): THREE.Vector2 {
    const { p, body, head, color } = b;
    const r = body.headRadius;
    const faceR = r * (1 + p.faceLift);
    const layer = (n: number) => faceR * (1 + n * p.faceLayerGap);
    const eyeX = r * p.eyeSpacing;
    const eyeY = r * p.eyeHeight;
    const eyeSize = r * p.eyeSize;

    // Normalise ONCE, after setting z: normalise (x, y) first and the proportion is
    // lost, pinning every eye to the side of the head.
    const faceDir = (x: number, y: number) => v(x, y, r * 0.9).normalize();

    const decal = (opts: FaceDecal) =>
        addDecal(b.shell, {
            centre: head.centre,
            surface: head.surface,
            spacing: p.featureSpacing,
            sizeScale: p.decalSize,
            owner: HEAD,
            ...opts,
        });

    // A line along a curve, tapering at the ends. `rise(u)` is the curve, u in [-1, 1]:
    // a smile, a shut eye and a wobble are all this. A layer above the eye outlines,
    // since a thin dark line is where skin sorting in front shows worst.
    const stroke = (
        dir: THREE.Vector3,
        halfWidth: number,
        thickness: number,
        amplitude: number,
        rise: (u: number) => number,
        radius = layer(3),
    ) => {
        const halfHeight = thickness + amplitude;
        decal({
            dir,
            radius,
            halfWidth,
            halfHeight,
            inside: (u, vv) => {
                const ends = Math.max(0, 1 - Math.abs(u) ** p.mouthShape) ** (1 / p.mouthShape);
                return Math.abs(vv * halfHeight - rise(u)) <= thickness * ends;
            },
            sizeScale: 1,
            color: color.dark,
        });
    };

    // An eye: outline, white, then pupil and glints, each a filled decal on the last.
    const eyeOutline = lidShape(p.eyeTopFlat, p.eyeBottomRound);
    const eye = (sx: number, look: { wide: number; tall: number; pupil: number; shine: number }) => {
        const dir = faceDir(sx * eyeX, eyeY);
        const w = eyeSize * p.eyeWidth * look.wide;
        const h = eyeSize * p.eyeTall * look.tall;
        decal({ dir, radius: layer(1), halfWidth: w, halfHeight: h, inside: eyeOutline, color: color.dark });
        // A constant inset, not a scale, so the rim is even all round.
        const rim = eyeSize * p.eyeOutline;
        decal({
            dir,
            radius: layer(2),
            halfWidth: Math.max(1e-4, w - rim),
            halfHeight: Math.max(1e-4, h - rim),
            inside: eyeOutline,
            color: color.sclera,
        });
        const pupilW = eyeSize * p.eyeWidth * look.pupil;
        const pupilH = eyeSize * p.eyeTall * look.pupil;
        const pupilY = eyeY + eyeSize * p.pupilY * look.tall;
        // Pupil and glints ride the GAZE bone, so the eyes can look around.
        pin(b, GAZE, () => {
            decal({
                dir: faceDir(sx * eyeX, pupilY),
                radius: layer(3),
                halfWidth: pupilW,
                halfHeight: pupilH,
                inside: superellipse(2),
                color: color.pupil,
            });
            // Glints to the same side on both eyes: mirrored, they look cross-eyed.
            if (look.shine <= 0) return;
            for (const [ox, oy, size] of [
                [0.38, 0.42, 1],
                [-0.3, -0.38, 0.45],
            ]) {
                const glint = pupilW * look.shine * size;
                decal({
                    dir: faceDir(sx * eyeX + pupilW * ox, pupilY + pupilH * oy),
                    radius: layer(4),
                    halfWidth: glint,
                    halfHeight: glint,
                    inside: superellipse(2),
                    color: color.sclera,
                });
            }
        });
    };

    // A rounded bar. Positive angles lower the inner end; negative lift it.
    const brow = (sx: number, gap: number, angle: number) =>
        decal({
            dir: faceDir(sx * eyeX * 1.04, eyeY + eyeSize * gap),
            radius: layer(2),
            halfWidth: eyeSize * p.browWidth,
            halfHeight: eyeSize * p.browThickness,
            roll: sx * angle,
            inside: superellipse(p.browShape),
            color: color.hair,
        });

    const mouthDir = faceDir(0, r * p.mouthY);
    const mouthThick = r * p.mouthThickness;

    pin(b, HEAD, () => {
        for (const sx of [1, -1]) {
            part(b, 'eyesOpen', () => eye(sx, { wide: 1, tall: 1, pupil: p.pupilSize, shine: p.eyeShine }));
            // Wide and tall with pinprick pupils: frightened.
            part(b, 'eyesWide', () => eye(sx, { wide: 1.12, tall: 1.25, pupil: p.pupilSize * 0.42, shine: p.eyeShine * 1.3 }));
            // Shut, as a contented ^ ^ rather than asleep.
            const arch = eyeSize * p.eyeTall * 0.45;
            part(b, 'eyesShut', () =>
                stroke(
                    faceDir(sx * eyeX, eyeY),
                    eyeSize * p.eyeWidth * 1.05,
                    eyeSize * 0.13,
                    arch / 2,
                    (u) => -arch * (u * u - 0.5),
                    layer(2),
                ),
            );
            // An X for each eye, clipped to a disc so the arms finish round.
            const size = eyeSize * Math.min(p.eyeWidth, p.eyeTall) * 1.05;
            part(b, 'eyesCrossed', () =>
                decal({
                    dir: faceDir(sx * eyeX, eyeY),
                    radius: layer(2),
                    halfWidth: size,
                    halfHeight: size,
                    inside: (u, vv) => (Math.abs(u - vv) < 0.3 || Math.abs(u + vv) < 0.3) && u * u + vv * vv < 1.15,
                    color: color.dark,
                }),
            );

            part(b, 'browsCalm', () => brow(sx, p.browGap, p.browAngle));
            part(b, 'browsWorried', () => brow(sx, p.browGap * 1.4, -0.4));
            part(b, 'browsDizzy', () => brow(sx, p.browGap * 1.15, -0.25));
        }

        const bend = r * p.mouthCurve;
        part(b, 'mouthSmile', () =>
            stroke(mouthDir, r * p.mouthWidth, mouthThick, Math.abs(bend) / 2, (u) => bend * (u * u - 0.5)),
        );
        part(b, 'mouthO', () =>
            decal({
                dir: faceDir(0, r * (p.mouthY - 0.02)),
                radius: layer(3),
                halfWidth: r * 0.055,
                halfHeight: r * 0.075,
                inside: superellipse(2),
                sizeScale: 1,
                color: color.dark,
            }),
        );
        const wobble = r * 0.022;
        part(b, 'mouthWobble', () =>
            stroke(mouthDir, r * p.mouthWidth * 1.1, mouthThick, wobble, (u) => wobble * Math.sin(u * Math.PI * 2.5)),
        );

        // Cheeks on the lowest layer, so a big blush can't cover the eyes.
        if (p.blushStrength > 0) {
            for (const sx of [1, -1]) {
                decal({
                    dir: faceDir(sx * eyeX * 1.4, eyeY - eyeSize * 1.35),
                    radius: layer(0),
                    halfWidth: eyeSize * p.blushSize,
                    halfHeight: eyeSize * p.blushSize * 0.6,
                    inside: superellipse(2),
                    color: color.blush,
                });
            }
        }

        // The nose: barely there.
        addSphere(
            b.shell,
            v(0, body.headY - r * 0.12, r * 0.995),
            r * p.noseSize,
            p.spacing * 0.7,
            color.skin.clone().multiplyScalar(0.92),
            HEAD,
        );
    });

    // The white's half-extent less the pupil's, with a margin for the rim.
    const rim = eyeSize * p.eyeOutline;
    return new THREE.Vector2(
        Math.max(0, eyeSize * p.eyeWidth * (1 - p.pupilSize) - rim) * 0.8,
        Math.max(0, eyeSize * p.eyeTall * (1 - p.pupilSize) - rim) * 0.6,
    );
}

/* arms and legs */
function buildLimbs(b: Build): void {
    const { p, body, color } = b;
    const lr = body.limbRadius;
    const tube = { capA: 'none', capB: 'none', layers: p.layers } as const;

    for (const [upper, fore, sx] of [
        [ARM_L, FORE_L, 1],
        [ARM_R, FORE_R, -1],
    ] as const) {
        const shoulder = v(sx * body.shoulderX, body.shoulderY - p.armDrop, 0);
        const elbow = v(sx * body.elbow.x, body.elbow.y, 0);
        const hand = v(sx * body.hand.x, body.hand.y, 0);
        // No caps at the elbow: two capped capsules would overlap there.
        addCapsule(b.shell, shoulder, elbow, lr * 1.04, lr, p.spacing, color.skin, upper, tube);
        addCapsule(b.shell, elbow, hand, lr, lr * 0.92, p.spacing, color.skin, fore, tube);
        // Pinned, or a ragdoll's sharply bent elbow stretches the hand into strands.
        pin(b, fore, () => addSphere(b.shell, hand, lr * 1.45, p.spacing, color.skin, fore, { layers: p.layers }));
        // The sleeve is a layer over the arm, cut with a flat ring for a hard edge.
        addCapsule(b.shell, shoulder, shoulder.clone().lerp(elbow, 0.42), lr * 1.18, lr * 1.12, p.spacing, color.shirt, upper, {
            capA: 'round',
            capB: 'flat',
            innerB: lr * 0.98,
            crispB: true,
            layers: p.layers,
        });
    }

    // Legs: no caps, since the torso closes the top and a rounded one would poke
    // through the hem.
    for (const [thigh, shin, sx] of [
        [THIGH_L, SHIN_L, 1],
        [THIGH_R, SHIN_R, -1],
    ] as const) {
        const hip = v(sx * body.hipX, body.crotchY + 0.02, 0);
        const knee = v(sx * body.hipX, body.kneeY, 0);
        const ankle = v(sx * body.hipX, 0.07, 0);
        addCapsule(b.shell, hip, knee, lr * 1.3, lr * 1.12, p.spacing, color.trousers, thigh, tube);
        addCapsule(b.shell, knee, ankle, lr * 1.12, lr, p.spacing, color.trousers, shin, tube);
        // Pushed forward, for a toe.
        addSphere(b.shell, v(sx * body.hipX, 0.045, 0.035), lr * 1.5, p.spacing, color.shoe, shin, {
            radii: v(lr * 1.25, lr * 0.85, lr * 2.1),
            layers: p.layers,
        });
    }
}

/* into a SplatMesh */
/** A splat is a disc, not a point, so its visible edge reaches past its centre. */
function lowestPoint(b: Build): number {
    let lowest = Number.POSITIVE_INFINITY;
    const { centers } = b.shell;
    for (let i = 1; i < centers.length; i += 3) lowest = Math.min(lowest, centers[i]);
    return lowest - b.p.spacing * b.p.overlap;
}

/** Spans flattened to one value per splat; the first span claiming a splat wins. */
function perSplat(spans: Span[], count: number): Int16Array {
    const out = new Int16Array(count).fill(-1);
    for (const span of spans) {
        for (let i = span.start; i < span.end; i++) if (out[i] < 0) out[i] = span.value;
    }
    return out;
}

// The shell's flat numbers pass through these on their way into Spark.
const splatCenter = new THREE.Vector3();
const splatScales = new THREE.Vector3();
const splatQuat = new THREE.Quaternion();
const splatTint = new THREE.Color();

/** Splats into a mesh, skinned to the skeleton, with the face-part mask attached. */
function toMesh(b: Build) {
    const { p, shell, body } = b;
    const count = splatCount(shell);
    // Pins are recorded as they close, so inner pins come first and win.
    const pinOf = perSplat(b.pins, count);
    const partOf = perSplat(b.parts, count);

    // Spark workaround: not `constructSplats`, which initialises the mesh ASYNC, and the
    // skinning below needs numSplats now.
    // Spark workaround: opacity past 1 (hardness) needs `lodOpacity`, which stores it
    // halved — and pushSplat doesn't apply the encoding itself, so halve it here.
    const mesh = new SplatMesh({});
    if (mesh.packedSplats) mesh.packedSplats.splatEncoding = { ...mesh.packedSplats.splatEncoding, lodOpacity: true };
    for (let i = 0; i < count; i++) {
        // Face decals stay soft: hard discs that small look scratchy.
        const hardness = partOf[i] >= 0 ? 1 : p.hardness;
        mesh.pushSplat(
            splatCenter.fromArray(shell.centers, i * 3),
            splatScales.fromArray(shell.scales, i * 3),
            splatQuat.fromArray(shell.quats, i * 4),
            hardness / 2,
            splatTint.fromArray(shell.colors, i * 3),
        );
    }
    mesh.numSplats = mesh.packedSplats?.numSplats ?? 0;
    if (mesh.packedSplats) mesh.packedSplats.needsUpdate = true;

    const skinning = new SplatSkinning({
        mesh,
        numSplats: mesh.numSplats,
        numBones: BONE_COUNT,
        mode: SplatSkinningMode.DUAL_QUATERNION,
    });
    const restQuat = new THREE.Quaternion();
    for (let i = 0; i < body.bones.length; i++) skinning.setRestQuatPos(i, restQuat, body.bones[i].head);
    // The gaze bone rests where the head does.
    skinning.setRestQuatPos(GAZE, restQuat, body.bones[HEAD].head);

    const indices = new THREE.Vector4();
    const weights = new THREE.Vector4();
    for (let i = 0; i < count; i++) {
        if (pinOf[i] >= 0) {
            indices.set(pinOf[i], 0, 0, 0);
            weights.set(1, 0, 0, 0);
        } else {
            weightsForPoint(splatCenter.fromArray(shell.centers, i * 3), body.bones, indices, weights, shell.owners[i]);
        }
        skinning.setSplatBones(i, indices, weights);
    }
    skinning.skinTexture.needsUpdate = true;
    mesh.skinning = skinning;

    // Each splat's face part + 1 (0 for the body), for the modifier to look up.
    const rows = Math.max(1, Math.ceil(count / PART_TEX_WIDTH));
    const partData = new Float32Array(PART_TEX_WIDTH * rows);
    for (let i = 0; i < count; i++) partData[i] = partOf[i] + 1;
    const partTexture = new THREE.DataTexture(partData, PART_TEX_WIDTH, rows, THREE.RedFormat, THREE.FloatType);
    partTexture.needsUpdate = true;
    const faceShowing = d.dynoInt(partMask('happy'));
    mesh.objectModifier = faceModifier(d.dynoSampler2D(partTexture), faceShowing);
    mesh.updateGenerator();

    return { mesh, skinning, partTexture, faceShowing };
}

/* posing */

const xAxis = new THREE.Vector3(1, 0, 0);
const yAxis = new THREE.Vector3(0, 1, 0);
const zAxis = new THREE.Vector3(0, 0, 1);
const armSet = new THREE.Quaternion();
const lookTurn = new THREE.Quaternion();

/** Peak thigh swing, in radians. Stride length follows from this and leg length. */
const THIGH_SWING = 0.52;

/** How far one step carries the body. The gait rate follows from this, or the feet slide. */
export function strideLength(params: AvatarParams): number {
    return 2 * params.hipY * Math.sin(THIGH_SWING);
}

/**
 * Pose the avatar at `phase` radians through its gait (two steps per 2π). `gait`
 * fades the walk to a standing breath; stopping the phase instead would freeze them
 * mid-step.
 */
export function poseAvatar(avatar: Avatar, phase: number, gait = 1): void {
    const { skeleton } = avatar;
    const swing = Math.sin(phase) * gait;
    const pose = skeleton.pose;
    const legLength = avatar.params.hipY;
    const still = 1 - gait;

    // Positive swings the leg BACK: left is rearmost at PI/2, forward by 3PI/2.
    pose[THIGH_L].setFromAxisAngle(xAxis, swing * THIGH_SWING);
    pose[THIGH_R].setFromAxisAngle(xAxis, -swing * THIGH_SWING);
    // The knee bends as the leg swings through, to lift the foot clear.
    pose[SHIN_L].setFromAxisAngle(xAxis, Math.max(0, -Math.cos(phase)) ** 1.3 * gait * 0.95);
    pose[SHIN_R].setFromAxisAngle(xAxis, Math.max(0, Math.cos(phase)) ** 1.3 * gait * 0.95);

    // Arms counter-swing, set slightly out even when standing.
    pose[ARM_L].setFromAxisAngle(xAxis, -swing * 0.42).multiply(armSet.setFromAxisAngle(zAxis, -0.12));
    pose[ARM_R].setFromAxisAngle(xAxis, swing * 0.42).multiply(armSet.setFromAxisAngle(zAxis, 0.12));
    pose[FORE_L].setFromAxisAngle(xAxis, 0.18 + 0.12 * swing);
    pose[FORE_R].setFromAxisAngle(xAxis, 0.18 - 0.12 * swing);

    pose[PELVIS].setFromAxisAngle(yAxis, -swing * 0.13);
    pose[CHEST].setFromAxisAngle(yAxis, swing * 0.2);
    // The head lags the shoulders walking, looks about slowly standing, and turns
    // toward whatever they're looking at.
    pose[HEAD].setFromAxisAngle(yAxis, -Math.sin(phase - 0.45) * 0.14 * gait + Math.sin(phase * 0.37) * 0.07 * still);
    pose[HEAD].multiply(lookTurn.setFromAxisAngle(yAxis, avatar.look.x));
    pose[HEAD].multiply(lookTurn.setFromAxisAngle(xAxis, -avatar.look.y));

    // Bob twice a cycle and sway onto the weighted foot; standing, just breathe.
    const bob = Math.abs(Math.cos(phase)) * legLength * 0.075 * gait;
    const sway = swing * legLength * 0.045;
    const breath = Math.sin(phase * 0.5) * legLength * 0.014 * still;
    skeleton.rootOffset.set(sway, bob - legLength * 0.037 * gait + breath, 0);

    poseSkeleton(skeleton);
}

/** Pose and draw. The crowd calls the two halves separately, to blend in a ragdoll. */
export function updateAvatar(avatar: Avatar, phase: number): void {
    poseAvatar(avatar, phase);
    pushAvatar(avatar);
}

/* to Spark */

const gazeQuat = new THREE.Quaternion();
const gazePos = new THREE.Vector3();
const restIdentity = new THREE.Quaternion();

/** Hand the pose to Spark, along with which face is showing and where it's looking. */
export function pushAvatar(avatar: Avatar): void {
    const mask = partMask(avatar.expression);
    if (avatar.faceShowing.value !== mask) {
        avatar.faceShowing.value = mask;
        avatar.mesh.updateVersion();
    }
    // The gaze bone is the head, slid across the face. Before pushSkeleton, which uploads.
    const { skeleton } = avatar;
    gazeQuat.copy(skeleton.worldQuat[HEAD]);
    gazePos
        .set(avatar.gaze.x * avatar.gazeRange.x, avatar.gaze.y * avatar.gazeRange.y, 0)
        .applyQuaternion(gazeQuat)
        .add(skeleton.worldPos[HEAD]);
    setBoneWorld(avatar.skinning, GAZE, restIdentity, skeleton.bones[HEAD].head, gazeQuat, gazePos);
    pushSkeleton(skeleton, avatar.skinning);
}

function partMask(expression: Expression): number {
    let mask = 0;
    for (const name of EXPRESSION_PARTS[expression]) mask |= 1 << FACE_PARTS.indexOf(name);
    return mask;
}

/** Zeroes the opacity of every face part not in `showing`. Body splats pass through. */
function faceModifier(parts: ReturnType<typeof d.dynoSampler2D>, showing: ReturnType<typeof d.dynoInt>) {
    return d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
        if (!gsplat) throw new Error('face modifier: no gsplat input');
        const node = d.dyno({
            inTypes: { gsplat: d.Gsplat, parts: 'sampler2D', showing: 'int' },
            outTypes: { gsplat: d.Gsplat },
            inputs: { gsplat, parts, showing },
            globals: () => [d.defineGsplat],
            statements: ({ inputs, outputs }) =>
                d.unindentLines(`
                    ${outputs.gsplat} = ${inputs.gsplat};
                    int i = ${inputs.gsplat}.index;
                    int part = int(texelFetch(${inputs.parts}, ivec2(i % ${PART_TEX_WIDTH}, i / ${PART_TEX_WIDTH}), 0).r);
                    if (part > 0 && ((${inputs.showing} >> (part - 1)) & 1) == 0) {
                        ${outputs.gsplat}.rgba.a = 0.0;
                    }
                `),
        });
        return { gsplat: node.outputs.gsplat };
    });
}

/* shell: splat surface primitives */

/**
 * Surface SHELLS, not filled volumes: a crust of flat discs lying tangent to the
 * surface, as in a real capture. It's most of what makes these look like splats
 * rather than a cloud of beads.
 */

/**
 * Colour for a splat. Spark wants sRGB, but `new THREE.Color('#c1875a')` is linear;
 * pass that straight in and it's linearised twice, and skin tones go to mud.
 */
function splatColor(style: string | number): THREE.Color {
    return new THREE.Color(style).convertLinearToSRGB();
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Seeded, so a seed always builds the same character.
let noiseState = 1;
function resetNoise(seed: number) {
    noiseState = seed >>> 0 || 1;
}
function noise() {
    noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
    return noiseState / 0x100000000 - 0.5;
}

const jitterA = new THREE.Vector3();
const jitterB = new THREE.Vector3();

/** Scatter a point within its own tangent plane, so it stays on the surface. */
function jitter(shell: Shell, point: THREE.Vector3, normal: THREE.Vector3, spacing: number): void {
    const amount = spacing * shell.settings.jitter;
    if (amount <= 0) return;
    jitterA.set(normal.z, normal.x, normal.y).cross(normal).normalize();
    jitterB.copy(normal).cross(jitterA);
    point.addScaledVector(jitterA, noise() * amount);
    point.addScaledVector(jitterB, noise() * amount);
}

/** How flat each disc is, as a fraction of its in-plane size. */
const FLATNESS = 0.16;

type ShellSettings = {
    /**
     * Disc radius over sampling spacing: too wide and the surface is fog, too narrow
     * and it's specks. Wanting both means sampling closer, not changing this.
     */
    overlap: number;
    /**
     * Scatter off the lattice, as a fraction of spacing. Two perfectly regular shells
     * stacked interfere into a moiré that reads as woven fabric.
     */
    jitter: number;
};

/**
 * The splats so far, flat: xyz, xyzw, xyz and rgb per splat. Plain numbers rather than
 * a three.js object each, so building a character allocates nothing per splat.
 */
type Shell = {
    settings: ShellSettings;
    centers: number[];
    quats: number[];
    scales: number[];
    colors: number[];
    /** Which bone each splat was built as part of (see `weightsForPoint`); one per splat. */
    owners: number[];
};

const splatCount = (shell: Shell) => shell.owners.length;

const Z = new THREE.Vector3(0, 0, 1);

function createShell(seed: number, settings: ShellSettings): Shell {
    resetNoise(seed * 2654435761);
    return { settings, centers: [], quats: [], scales: [], colors: [], owners: [] };
}

/** One tangent disc at `center`, lying perpendicular to `normal`. */
function addDisc(
    shell: Shell,
    center: THREE.Vector3,
    normal: THREE.Vector3,
    spacing: number,
    color: THREE.Color,
    owner: number,
    /** Fatten the discs without moving them closer — a flat decal can't stack layers. */
    sizeScale = 1,
): void {
    const size = spacing * shell.settings.overlap * sizeScale;
    // Local +Z is the disc's thin axis.
    pushDisc(shell, center, discQuat.setFromUnitVectors(Z, normal), size, size, color, owner);
}

const discQuat = new THREE.Quaternion();

function pushDisc(
    shell: Shell,
    center: THREE.Vector3,
    quat: THREE.Quaternion,
    width: number,
    height: number,
    color: THREE.Color,
    owner: number,
): void {
    shell.centers.push(center.x, center.y, center.z);
    shell.quats.push(quat.x, quat.y, quat.z, quat.w);
    shell.scales.push(width, height, width * FLATNESS);
    shell.colors.push(color.r, color.g, color.b);
    shell.owners.push(owner);
}

/**
 * How far a disc visibly reaches, in multiples of its scale. A Gaussian has no edge,
 * but past about this it's faint enough not to read as colour.
 */
const DISC_REACH = 2.2;
const edgeBasis = new THREE.Matrix4();
const edgeU = new THREE.Vector3();
const edgeV = new THREE.Vector3();

/**
 * A disc beside a colour edge or a cut: unjittered, and squashed across the edge so
 * it stops at the line instead of poking past it, which makes edges ragged.
 * `distance` is how far its centre is from the edge, along `across`.
 */
function addEdgeDisc(
    shell: Shell,
    center: THREE.Vector3,
    normal: THREE.Vector3,
    across: THREE.Vector3,
    distance: number,
    spacing: number,
    color: THREE.Color,
    owner: number,
): void {
    const size = spacing * shell.settings.overlap;
    // Tangent frame: v across the edge, u along it, normal through the disc.
    edgeU.copy(across).cross(normal).normalize();
    edgeV.copy(normal).cross(edgeU).normalize();
    edgeBasis.makeBasis(edgeU, edgeV, normal);
    const squash = THREE.MathUtils.clamp(distance / (DISC_REACH * size), 0.25, 1);
    pushDisc(shell, center, discQuat.setFromRotationMatrix(edgeBasis), size, size * squash, color, owner);
}

type SphereOptions = {
    /** Keep only points whose unit-sphere y is above this, for caps like hair. */
    minY?: number;
    /** Any other filter on the unit-sphere point, like a hairline. */
    keep?: (unit: THREE.Vector3) => boolean;
    /** Scale the x/z radii by height — how a head gets a chin. */
    taper?: (unitY: number) => number;
    radii?: THREE.Vector3;
    quat?: THREE.Quaternion;
    /**
     * How many shells to stack, each just inside the last. One layer of small discs
     * is see-through between their centres; an inner shell plugs the gaps while
     * hiding behind the outer one at the silhouette, so the outline stays crisp.
     */
    layers?: number;
};

/**
 * A sphere or ellipsoid shell, sampled with the Fibonacci lattice — even spacing
 * everywhere, with none of the bunching at the poles that a lat/long grid gives.
 */
function addSphere(
    shell: Shell,
    center: THREE.Vector3,
    radius: number,
    spacing: number,
    color: THREE.Color,
    owner: number,
    options: SphereOptions = {},
): void {
    const baseRadii = options.radii ?? new THREE.Vector3(radius, radius, radius);
    const layers = options.layers ?? 1;
    const inset = spacing * shell.settings.overlap;

    const radii = new THREE.Vector3();
    const unit = new THREE.Vector3();
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let layer = 0; layer < layers; layer++) {
        radii.set(
            Math.max(1e-4, baseRadii.x - layer * inset),
            Math.max(1e-4, baseRadii.y - layer * inset),
            Math.max(1e-4, baseRadii.z - layer * inset),
        );
        // From the radii actually covered, not the nominal `radius`.
        const mean = (radii.x + radii.y + radii.z) / 3;
        const area = 4 * Math.PI * mean * mean;
        const count = Math.max(24, Math.round(area / (spacing * spacing)));
        // Each layer offset, so its discs land in the gaps of the one before.
        const phase = layer * 0.5;

        for (let i = 0; i < count; i++) {
            const y = 1 - (i / (count - 1)) * 2;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = (i + phase) * GOLDEN_ANGLE;
            unit.set(Math.cos(theta) * r, y, Math.sin(theta) * r);

            if (options.minY !== undefined && unit.y < options.minY) continue;
            if (options.keep && !options.keep(unit)) continue;

            const k = options.taper ? options.taper(unit.y) : 1;
            const rx = radii.x * k;
            const rz = radii.z * k;
            point.set(unit.x * rx, unit.y * radii.y, unit.z * rz);
            // The ellipsoid normal is p / radii² (approximate under a taper; unlit, so fine).
            normal.set(point.x / (rx * rx), point.y / (radii.y * radii.y), point.z / (rz * rz)).normalize();

            if (options.quat) {
                point.applyQuaternion(options.quat);
                normal.applyQuaternion(options.quat);
            }
            point.add(center);
            jitter(shell, point, normal, spacing);
            addDisc(shell, point, normal, spacing, color, owner);
        }
    }
}

/** A flat filled disc, sunflower-sampled: a straight cut instead of a rounded cap. */
function addFlatCap(
    shell: Shell,
    center: THREE.Vector3,
    normal: THREE.Vector3,
    radius: number,
    spacing: number,
    color: THREE.Color,
    owner: number,
    /** Leave a hole, making a ring, for a cut over something else — a sleeve over an arm. */
    innerRadius = 0,
): void {
    const side = (Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).cross(normal).normalize();
    const other = normal.clone().cross(side).normalize();
    const radial = new THREE.Vector3();

    // A ring narrower than a couple of discs: one circle of discs squashed to fit,
    // rather than scattered ones poking out both sides.
    const width = radius - innerRadius;
    if (innerRadius > 0 && width < 2 * spacing) {
        const mid = innerRadius + width / 2;
        const around = Math.max(8, Math.ceil((2 * Math.PI * mid) / (spacing * 0.7)));
        const point = new THREE.Vector3();
        for (let i = 0; i < around; i++) {
            const theta = (i / around) * Math.PI * 2;
            radial.copy(side).multiplyScalar(Math.cos(theta)).addScaledVector(other, Math.sin(theta));
            point.copy(center).addScaledVector(radial, mid);
            addEdgeDisc(shell, point, normal, radial, width / 2, spacing, color, owner);
        }
        return;
    }

    const area = Math.PI * (radius * radius - innerRadius * innerRadius);
    const count = Math.max(8, Math.round(area / (spacing * spacing)));
    const point = new THREE.Vector3();
    const innerSq = innerRadius * innerRadius;
    const span = radius * radius - innerSq;

    for (let i = 0; i < count; i++) {
        const r = Math.sqrt(innerSq + span * ((i + 0.5) / count));
        const theta = i * GOLDEN_ANGLE;
        point
            .copy(center)
            .addScaledVector(side, Math.cos(theta) * r)
            .addScaledVector(other, Math.sin(theta) * r);
        // Near the rim, keep the disc inside it.
        if (radius - r < spacing) {
            radial.copy(point).sub(center).normalize();
            addEdgeDisc(shell, point, normal, radial, radius - r, spacing, color, owner);
            continue;
        }
        jitter(shell, point, normal, spacing);
        addDisc(shell, point, normal, spacing, color, owner);
    }
}

type CapMode = 'round' | 'flat' | 'none';

type CapsuleOptions = {
    capA?: CapMode;
    capB?: CapMode;
    /** Hole radius for a 'flat' cap, making it a ring — see addFlatCap. */
    innerA?: number;
    innerB?: number;
    /** See SphereOptions.layers. */
    layers?: number;
    /** A clean cut at that end, rather than rings spilling past it. */
    crispA?: boolean;
    crispB?: boolean;
};

/** A tapered capsule shell, for limbs and sleeves. */
function addCapsule(
    shell: Shell,
    a: THREE.Vector3,
    b: THREE.Vector3,
    radiusA: number,
    radiusB: number,
    spacing: number,
    color: THREE.Color,
    owner: number,
    options: CapsuleOptions = {},
): void {
    const layers = options.layers ?? 1;
    const inset = spacing * shell.settings.overlap;
    const axis = b.clone().sub(a);
    const length = axis.length();
    axis.normalize();

    const seed = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const side = seed.clone().cross(axis).normalize();
    const other = axis.clone().cross(side).normalize();

    const rings = Math.max(2, Math.round(length / spacing));
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    // A tapered wall leans, so its normal tilts along the axis.
    const lean = (radiusA - radiusB) / length;

    for (let layer = 0; layer < layers; layer++) {
        const rA = Math.max(1e-4, radiusA - layer * inset);
        const rB = Math.max(1e-4, radiusB - layer * inset);
        // A crisp end's last ring sits half a step in, so the cut falls between rings.
        const first = options.crispA ? 0.5 : 0;
        const last = options.crispB ? rings - 0.5 : rings;
        for (let i = first; i <= last + 1e-6; i++) {
            const t = i / rings;
            const radius = THREE.MathUtils.lerp(rA, rB, t);
            const toA = options.crispA ? t * length : Number.POSITIVE_INFINITY;
            const toB = options.crispB ? (1 - t) * length : Number.POSITIVE_INFINITY;
            const toEnd = Math.min(toA, toB);
            const around = Math.max(6, Math.round((2 * Math.PI * radius) / spacing));
            for (let j = 0; j < around; j++) {
                // Stagger alternate rings and layers, so nothing lines up.
                const ang = ((j + (Math.floor(i) % 2) * 0.5 + layer * 0.37) / around) * Math.PI * 2;
                const cos = Math.cos(ang);
                const sin = Math.sin(ang);
                point
                    .copy(a)
                    .addScaledVector(axis, t * length)
                    .addScaledVector(side, cos * radius)
                    .addScaledVector(other, sin * radius);
                normal
                    .set(0, 0, 0)
                    .addScaledVector(side, cos)
                    .addScaledVector(other, sin)
                    .addScaledVector(axis, lean)
                    .normalize();
                if (toEnd < spacing) {
                    addEdgeDisc(shell, point, normal, axis, toEnd, spacing, color, owner);
                    continue;
                }
                jitter(shell, point, normal, spacing);
                addDisc(shell, point, normal, spacing, color, owner);
            }
        }
    }

    const capA = options.capA ?? 'round';
    const capB = options.capB ?? 'round';
    const down = axis.clone().negate();

    if (capA === 'round') {
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), down);
        addSphere(shell, a, radiusA, spacing, color, owner, { minY: 0.05, quat, layers });
    } else if (capA === 'flat') {
        addFlatCap(shell, a, down, radiusA, spacing, color, owner, options.innerA ?? 0);
    }

    if (capB === 'round') {
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        addSphere(shell, b, radiusB, spacing, color, owner, { minY: 0.05, quat, layers });
    } else if (capB === 'flat') {
        addFlatCap(shell, b, axis, radiusB, spacing, color, owner, options.innerB ?? 0);
    }
}

/**
 * A flat shape laid onto a curved surface — how the face is drawn, since none of its
 * features is an ellipse. Sample a 2D lattice in the feature's plane, keep what
 * `inside(u, v)` accepts over [-1, 1], and project it onto the surface.
 */
function addDecal(
    shell: Shell,
    opts: {
        /** Centre of the sphere the decal wraps onto, and how far out it sits. */
        centre: THREE.Vector3;
        dir: THREE.Vector3;
        radius: number;
        halfWidth: number;
        halfHeight: number;
        /** Rotation within the decal's own plane, in radians. */
        roll?: number;
        /** Multiplier on `radius` by direction, to wrap a surface that isn't a sphere. */
        surface?: (dir: THREE.Vector3) => number;
        inside: (u: number, v: number) => boolean;
        spacing: number;
        color: THREE.Color;
        owner: number;
        /** See addDisc. */
        sizeScale?: number;
    },
): void {
    const { centre, dir, radius, halfWidth, halfHeight, inside, spacing, color, owner } = opts;
    const roll = opts.roll ?? 0;

    const forward = dir.clone().normalize();
    const seed = Math.abs(forward.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = seed.clone().cross(forward).normalize();
    const up = forward.clone().cross(right).normalize();

    const cos = Math.cos(roll);
    const sin = Math.sin(roll);

    const nu = Math.max(2, Math.ceil((2 * halfWidth) / spacing));
    const nv = Math.max(2, Math.ceil((2 * halfHeight) / spacing));
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let iv = 0; iv <= nv; iv++) {
        const v = (iv / nv) * 2 - 1;
        for (let iu = 0; iu <= nu; iu++) {
            // Stagger alternate rows: a square grid leaves diamond gaps, hex doesn't.
            const u = ((iu + (iv % 2) * 0.5) / nu) * 2 - 1;
            if (!inside(u, v)) continue;

            const du = u * cos - v * sin;
            const dv = u * sin + v * cos;
            point
                .copy(forward)
                .multiplyScalar(radius)
                .addScaledVector(right, du * halfWidth)
                .addScaledVector(up, dv * halfHeight);
            normal.copy(point).normalize();
            point
                .copy(normal)
                .multiplyScalar(radius * (opts.surface ? opts.surface(normal) : 1))
                .add(centre);
            jitter(shell, point, normal, spacing);
            addDisc(shell, point, normal, spacing, color, owner, opts.sizeScale ?? 1);
        }
    }
}

/** Decal outlines: |u|^n + |v|^n <= 1. n = 2 is an ellipse, 4 nearly a rounded rectangle. */
const superellipse = (n: number) => (u: number, v: number) => Math.abs(u) ** n + Math.abs(v) ** n <= 1;

/** An eye: flatter across the top, like a lid, and rounder underneath. */
const lidShape = (top: number, bottom: number) => (u: number, v: number) => {
    const n = v > 0 ? top : bottom;
    return Math.abs(u) ** n + Math.abs(v) ** n <= 1;
};

type LoftPoint = {
    y: number;
    /** Half-width at this height. */
    width: number;
    /** Half-depth, front to back. Defaults to a flattened fraction of the width. */
    depth?: number;
};

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Sample the profile at height `y`, smoothly through the control points. */
function sampleProfile(profile: LoftPoint[], y: number, key: 'width' | 'depth'): number {
    const get = (i: number) => {
        const p = profile[Math.max(0, Math.min(profile.length - 1, i))];
        return key === 'depth' ? (p.depth ?? p.width * 0.72) : p.width;
    };
    if (y <= profile[0].y) return get(0);
    if (y >= profile[profile.length - 1].y) return get(profile.length - 1);
    let i = 0;
    while (i < profile.length - 2 && y > profile[i + 1].y) i++;
    const span = profile[i + 1].y - profile[i].y;
    const t = span > 1e-6 ? (y - profile[i].y) / span : 0;
    return catmullRom(get(i - 1), get(i), get(i + 1), get(i + 2), t);
}

const ARC_SAMPLES = 256;
const arcX = new Float64Array(ARC_SAMPLES + 1);
const arcZ = new Float64Array(ARC_SAMPLES + 1);
const arcLen = new Float64Array(ARC_SAMPLES + 1);

/**
 * One continuous surface swept along an authored silhouette, with a superellipse
 * cross-section. Unlike a stack of capsules it has no joins, so nothing to
 * interpenetrate.
 */
function addLoft(
    shell: Shell,
    opts: {
        profile: LoftPoint[];
        /** Superellipse exponent for the cross-section. 2 = ellipse, 4 = rounded box. */
        roundness: number;
        spacing: number;
        /** Colour by height, so a garment boundary is a colour change on one surface. */
        colorAt: (y: number) => THREE.Color;
        /** Which bone owns a splat at this height — a torso spans two. */
        ownerAt: (y: number) => number;
        layers?: number;
        /** Close the bottom with a flat disc (a hem); the top is left open. */
        capBottom?: boolean;
        /** Heights where `colorAt` changes, given clean edge rings either side. */
        edges?: number[];
    },
): void {
    const { profile, roundness, spacing, colorAt, ownerAt } = opts;
    const layers = opts.layers ?? 1;
    const inset = spacing * shell.settings.overlap;

    const y0 = profile[0].y;
    const y1 = profile[profile.length - 1].y;
    const rings = Math.max(2, Math.ceil((y1 - y0) / spacing));

    // Ring heights: an even run between each pair of edges, stopping half a step short.
    const edges = (opts.edges ?? []).filter((e) => e > y0 && e < y1).sort((a, b) => a - b);
    const heights: number[] = [];
    if (edges.length === 0) {
        for (let i = 0; i <= rings; i++) heights.push(y0 + ((y1 - y0) * i) / rings);
    } else {
        const stops = [y0, ...edges, y1];
        for (let k = 0; k < stops.length - 1; k++) {
            const a = stops[k];
            const b = stops[k + 1];
            const n = Math.max(1, Math.round((b - a) / spacing));
            const step = (b - a) / n;
            const start = k > 0 ? a + step / 2 : a;
            const end = k < stops.length - 2 ? b - step / 2 : b;
            const count = Math.max(0, Math.round((end - start) / step));
            for (let i = 0; i <= count; i++) heights.push(count ? start + ((end - start) * i) / count : (start + end) / 2);
        }
    }
    const up = new THREE.Vector3(0, 1, 0);

    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let layer = 0; layer < layers; layer++) {
        for (let i = 0; i < heights.length; i++) {
            const y = heights[i];
            let toEdge = Number.POSITIVE_INFINITY;
            for (const e of edges) toEdge = Math.min(toEdge, Math.abs(y - e));
            const w = Math.max(1e-4, sampleProfile(profile, y, 'width') - layer * inset);
            const d = Math.max(1e-4, sampleProfile(profile, y, 'depth') - layer * inset);
            // The silhouette's slope, to tilt the normal.
            const h = Math.max(1e-4, (y1 - y0) / rings);
            const slope = (sampleProfile(profile, y + h, 'width') - sampleProfile(profile, y - h, 'width')) / (2 * h);

            // Walk the cross-section by arc length, not angle: on a superellipse, even
            // angles bunch splats into a seam down the chest.
            const e = 2 / roundness;
            arcX[0] = w;
            arcZ[0] = 0;
            arcLen[0] = 0;
            for (let k = 1; k <= ARC_SAMPLES; k++) {
                const a = (k / ARC_SAMPLES) * Math.PI * 2;
                const ca = Math.cos(a);
                const sa = Math.sin(a);
                arcX[k] = w * Math.sign(ca) * Math.abs(ca) ** e;
                arcZ[k] = d * Math.sign(sa) * Math.abs(sa) ** e;
                arcLen[k] = arcLen[k - 1] + Math.hypot(arcX[k] - arcX[k - 1], arcZ[k] - arcZ[k - 1]);
            }
            const perimeter = arcLen[ARC_SAMPLES];
            const steps = Math.max(12, Math.round(perimeter / spacing));
            for (let j = 0; j < steps; j++) {
                const target = (((j + (i % 2) * 0.5 + layer * 0.37) % steps) / steps) * perimeter;
                let cursor = 0;
                while (cursor < ARC_SAMPLES - 1 && arcLen[cursor + 1] < target) cursor++;
                const seg = Math.max(1e-9, arcLen[cursor + 1] - arcLen[cursor]);
                const f = (target - arcLen[cursor]) / seg;
                const px = arcX[cursor] + (arcX[cursor + 1] - arcX[cursor]) * f;
                const pz = arcZ[cursor] + (arcZ[cursor + 1] - arcZ[cursor]) * f;
                point.set(px, y, pz);
                const gx = w > 1e-6 ? (Math.sign(px) * Math.abs(px / w) ** (roundness - 1)) / w : 0;
                const gz = d > 1e-6 ? (Math.sign(pz) * Math.abs(pz / d) ** (roundness - 1)) / d : 0;
                normal.set(gx, 0, gz).normalize();
                normal.y = -slope;
                normal.normalize();
                if (toEdge < spacing) {
                    addEdgeDisc(shell, point, normal, up, toEdge, spacing, colorAt(y), ownerAt(y));
                    continue;
                }
                jitter(shell, point, normal, spacing);
                addDisc(shell, point, normal, spacing, colorAt(y), ownerAt(y));
            }
        }
    }

    if (opts.capBottom) {
        const w = sampleProfile(profile, y0, 'width');
        const d = sampleProfile(profile, y0, 'depth');
        const n = Math.max(8, Math.round((Math.PI * w * d) / (spacing * spacing)));
        const down = new THREE.Vector3(0, -1, 0);
        for (let k = 0; k < n; k++) {
            const r = Math.sqrt((k + 0.5) / n);
            const a = k * GOLDEN_ANGLE;
            point.set(Math.cos(a) * r * w, y0, Math.sin(a) * r * d);
            addDisc(shell, point, down, spacing, colorAt(y0), ownerAt(y0));
        }
    }
}
