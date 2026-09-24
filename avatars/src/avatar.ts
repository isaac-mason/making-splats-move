import { SplatMesh, SplatSkinning, SplatSkinningMode } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { type AvatarParams, DEFAULT_AVATAR } from './avatar-params';
import { type BoneDef, initSkeleton, poseSkeleton, pushSkeleton, type Skeleton, setBoneWorld, weightsForPoint } from './bones';
import { addCapsule, addDecal, addLoft, addSphere, createShell, lidShape, splatColor, superellipse } from './shell';

/**
 * A procedural avatar — a small stylised character, rigged and walking.
 *
 * Generated rather than scanned so that rigging is free: skeleton and geometry come
 * from the same numbers, so every bone is where it should be and every splat knows
 * which bone it belongs to.
 *
 * It still exercises dual-quaternion skinning across a hierarchy, four-bone blending
 * at the joints, and whether tangent-disc surfaces survive deformation. It does NOT
 * exercise joint placement, which is the part a real scan makes hard.
 */

// --- Bone indices, in the order they're defined below ------------------------
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

/**
 * Faces the avatar can pull.
 *
 * A face is assembled from PARTS — a pair of eyes, a pair of brows, a mouth — and
 * every variant of every part is built into the mesh on its own bone that rides the
 * head. `pushAvatar` leaves the parts the current expression uses on the face and
 * pulls the rest back inside the skull, where the skin hides them. So changing
 * expression is a bone move — no rebuild, and it can happen every frame.
 *
 * Parts rather than whole faces so that expressions sharing a feature share the
 * SPLATS: a blink swaps the eyes and nothing else. Swap whole faces and the mouth and
 * brows are traded for identical copies on every blink, which pops.
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

/** How far an inactive face is pulled back into the head, in headRadius. */
const FACE_HIDE_DEPTH = 0.5;

// Distance between adjacent splats on a surface. Tightening this is what buys
// sharpness — see OVERLAP in shell.ts — at a cost of splats going as 1/spacing².

function v(x: number, y: number, z: number) {
    return new THREE.Vector3(x, y, z);
}

/** What a face feature supplies; the decal helper in initAvatar fills in the rest. */
type FaceDecal = Omit<Parameters<typeof addDecal>[1], 'centre' | 'surface' | 'spacing' | 'owner'>;

export type Avatar = {
    /** Discriminant: these two are otherwise structurally identical. */
    kind: 'avatar';
    /** The numbers this one was built from — what the debug panel prints. */
    params: AvatarParams;
    /**
     * Height of the lowest splat, relative to the avatar's origin. Measured, not
     * calculated: the soles sit below the origin by an amount that depends on
     * limbRadius, so standing every avatar at the same y sinks the chunky ones.
     */
    feetY: number;
    mesh: SplatMesh;
    skinning: SplatSkinning;
    skeleton: Skeleton;
    /** Which face is showing. Set it freely; `pushAvatar` applies it. */
    expression: Expression;
    /** Skinning index of the first face bone — one per FACE_PARTS entry, after the skeleton's. */
    faceBone: number;
    /**
     * `mesh.dispose()` is not enough: SplatSkinning owns two GPU textures nothing
     * else releases, and a few seconds of dragging a slider leaks hundreds of MB.
     */
    dispose(): void;
};

export function initAvatar(params: AvatarParams = DEFAULT_AVATAR, seed = 1): Avatar {
    const p = params;

    // --- Proportions. Big head, stubby everything else. -----------------------
    const headRadius = p.headRadius;
    const hipY = p.hipY;
    const shoulderY = hipY + p.torsoHeight;
    // Multiples of headRadius above the shoulder line. There is NO NECK; `headHeight`
    // puts the chin exactly on that line, and slightly under hides the seam.
    const headY = shoulderY + headRadius * p.headSit;
    const torsoWidth = p.torsoWidth;
    const armLength = p.armLength;
    const limbRadius = p.limbRadius;

    const skin = splatColor(p.skin);
    const shirt = splatColor(p.shirt);
    const trousers = splatColor(p.trousers);
    const hair = splatColor(p.hair);
    const shoe = splatColor(p.shoes);
    const dark = splatColor('#1b1a20');
    const sclera = splatColor('#f8f5f1');
    const blush = skin.clone().lerp(splatColor('#ff7f93'), p.blushStrength);

    const shoulderX = torsoWidth * p.shoulderWidth * 0.92;
    const elbow = v(shoulderX + armLength * 0.36, shoulderY - armLength * 0.45, 0);
    const hand = v(shoulderX + armLength * 0.52, shoulderY - armLength * 0.95, 0);
    const kneeY = hipY * 0.52;
    const hipX = torsoWidth * 0.42;

    const BONES: BoneDef[] = [
        { name: 'pelvis', parent: -1, head: v(0, hipY, 0), tail: v(0, (hipY + shoulderY) / 2, 0), radius: torsoWidth },
        { name: 'chest', parent: PELVIS, head: v(0, (hipY + shoulderY) / 2, 0), tail: v(0, shoulderY, 0), radius: torsoWidth },
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

    // --- Geometry ------------------------------------------------------------
    const shell = createShell(seed, { overlap: p.overlap, jitter: p.jitter });

    // TORSO — one lofted surface, not a stack of capsules. Read down the `width`
    // column and you can see the silhouette. Every join between two capsules was two
    // closed surfaces interpenetrating, each visible only from some angle I wasn't
    // looking from; a loft has no joins to get wrong.
    const waistY = (hipY + shoulderY) / 2;
    const crotchY = hipY - p.hemDrop - 0.04;
    const hemY = hipY + p.hemDrop;
    addLoft(shell, {
        profile: [
            // Down past the hem to the crotch, so the shirt/trouser boundary is a
            // colour change on one surface rather than two solids meeting.
            { y: crotchY, width: torsoWidth * 0.94, depth: torsoWidth * 0.7 },
            { y: hipY - 0.02, width: torsoWidth * 1.02, depth: torsoWidth * 0.74 },
            { y: hipY + 0.05, width: torsoWidth * 1.0, depth: torsoWidth * 0.73 },
            { y: waistY, width: torsoWidth * 1.0, depth: torsoWidth * 0.72 },
            // The SHOULDERS, which are the whole silhouette: one broad sweep curving
            // up to the chin, with the deltoid AS the top of the torso. Narrow, and
            // the arms read as two balls stuck on. Wide but shallow is a shoulder.
            { y: shoulderY - 0.11, width: torsoWidth * 1.3, depth: torsoWidth * 0.78 },
            { y: shoulderY - 0.02, width: torsoWidth * p.shoulderWidth, depth: torsoWidth * 0.76 },
            // ...then it falls away fast into the chin.
            { y: shoulderY + p.chestRise * 0.4, width: torsoWidth * 0.82, depth: torsoWidth * 0.62 },
            { y: shoulderY + p.chestRise, width: torsoWidth * p.chestTaper, depth: torsoWidth * p.chestTaper * 0.8 },
        ],
        // Squarer than an ellipse across the chest, and flattened front to back —
        // a torso is not a tube.
        roundness: p.torsoRoundness,
        spacing: p.spacing,
        colorAt: (y) => (y < hemY ? trousers : shirt),
        ownerAt: (y) => (y < waistY ? PELVIS : CHEST),
        layers: p.layers,
        capBottom: true,
    });

    // An EGG, not a sphere: narrow, tall, tapering to a rounded chin. A sphere reads
    // as a ball with a face drawn on it — the chin is what makes it a head.
    const headTaper = (uy: number) => 1 - p.chinTaper * Math.max(0, -uy) ** 1.5;

    // Where the hair covers the skull, by which way a point faces on the unit sphere.
    // `lift` raises the cut at the front only — see the scalp below.
    //
    // The cut line depends on which way each point faces — straight above the brows,
    // dropping past the ears behind; a single minY threshold gives a bathing cap.
    // Carving that edge with a predicate is nearly free, where separate tufts would
    // each need building, placing, weighting and blending into the cap.
    const hairCovers = (u: THREE.Vector3, lift = 0) => {
        const front = Math.max(0, u.z);
        // Squared, so the cut fades back to a straight line around the temples
        // and leaves the sideburns clean.
        const frontness = front * front;
        const cut = THREE.MathUtils.lerp(p.hairBackY, p.fringeY, frontness);
        const az = Math.atan2(u.x, Math.max(u.z, 1e-4));
        // A TRIANGLE wave, not a cosine: that's scalloped versus jagged. A cosine
        // has zero gradient at its peaks, so every point arrives blunt.
        const cycles = az * p.fringePoints * 0.55 + p.fringePhase;
        const tooth = 1 - 2 * Math.abs(cycles - Math.floor(cycles) - 0.5);
        // ...plus one slow sweep, which gives a parting rather than symmetry.
        const sweep = p.fringeSweep * Math.sin(az + p.fringePhase);
        return u.y > cut + (lift - p.fringeDepth * tooth - sweep) * frontness;
    };

    // The skull, in two colours: skin, and hair wherever the hair will cover it. The
    // hair is a thin shell of soft discs, so a little of whatever is under it always
    // shows through — paint that the hair's colour and the gaps vanish, where making
    // the hair denser only makes them smaller and costs splats doing it.
    //
    // The painted edge is pulled up behind the fringe. The hair shell is bigger than
    // the skull, so seen from the front its edge sits HIGHER than the same point on
    // the skull; cut them at the same place and a dark band shows under the fringe.
    const skullRadii = v(headRadius * p.headWidth, headRadius * p.headHeight, headRadius * p.headDepth);
    const SCALP_LIFT = 0.14;
    addSphere(shell, v(0, headY, 0), headRadius, p.spacing, skin, HEAD, {
        layers: p.layers,
        radii: skullRadii,
        taper: headTaper,
        keep: (u) => !hairCovers(u, SCALP_LIFT),
    });
    addSphere(shell, v(0, headY, 0), headRadius, p.spacing, hair, HEAD, {
        layers: p.layers,
        radii: skullRadii,
        taper: headTaper,
        keep: (u) => hairCovers(u, SCALP_LIFT),
    });

    // Hair as a VOLUME on the skull, not paint: at 1.04x radius it has no silhouette
    // of its own, at 1.13x it reads as a mass with thickness.
    addSphere(shell, v(0, headY, 0), headRadius, p.spacing * p.hairSpacingScale, hair, HEAD, {
        layers: p.layers,
        radii: v(
            headRadius * p.headWidth * p.hairThickness,
            headRadius * p.headHeight * p.hairThickness,
            headRadius * p.headDepth * p.hairThickness,
        ),
        taper: headTaper,
        keep: (u) => hairCovers(u),
    });

    // Face. Everything sits proud of the skull so it draws in front of it — far
    // enough that the skin's own soft discs, which reach past its surface, can't sort
    // over a feature and bleed pale into it. Every feature is placed relative to this,
    // so raising it lifts the whole face at once. The character faces +Z.
    const faceR = headRadius * 1.025;
    const eyeX = headRadius * p.eyeSpacing;
    const eyeY = headY + headRadius * p.eyeHeight;
    const eyeSize = headRadius * p.eyeSize;
    const headCentre = v(0, headY, 0);

    // Distance to the skin along a direction, in headRadius — what the face decals
    // wrap onto. The head is a tapered ellipsoid, and a feature laid on a sphere
    // instead stands proud of the cheeks and sinks under the chin. The taper depends
    // on the lattice's y rather than the direction's, so a few fixed-point steps
    // converge on it.
    const headRadii = v(p.headWidth, p.headHeight, p.headDepth);
    const headSurface = (dir: THREE.Vector3) => {
        let uy = dir.y;
        let t = 1;
        for (let k = 0; k < 4; k++) {
            const taper = headTaper(uy);
            const x = dir.x / (headRadii.x * taper);
            const y = dir.y / headRadii.y;
            const z = dir.z / (headRadii.z * taper);
            t = 1 / Math.sqrt(x * x + y * y + z * z);
            uy = THREE.MathUtils.clamp((t * dir.y) / headRadii.y, -1, 1);
        }
        return t;
    };

    // Building the vector and normalising ONCE matters: normalise (x, y) and then set
    // z and the proportion between them is gone, pinning every eye to the side.
    const faceDir = (x: number, y: number) => v(x, y, headRadius * 0.9).normalize();

    // Decals, not ellipsoids (see addDecal): an ellipsoid can only draw an ellipse,
    // and none of a face's features is one.
    const eyeOutline = lidShape(p.eyeTopFlat, p.eyeBottomRound);
    const featureSpacing = p.spacing * p.featureSpacingScale;

    const decal = (owner: number, opts: FaceDecal) =>
        addDecal(shell, {
            centre: headCentre,
            surface: headSurface,
            spacing: featureSpacing,
            sizeScale: p.decalSize,
            owner,
            ...opts,
        });

    // Mouths sit a little further out than the rest of the face. They're thin dark
    // strokes on light skin, so any skin splat that sorts in front of one shows as
    // the line bleeding pale; the extra lift keeps them clear.
    const mouthR = faceR * 1.02;

    // A stroke of constant thickness along a curve, thinning to points at the ends.
    // `rise(u)` is the curve's height across the decal, u in [-1, 1], in world units —
    // a smile, a closed eye and a wobble are all this with a different curve.
    const stroke = (
        owner: number,
        dir: THREE.Vector3,
        halfWidth: number,
        thickness: number,
        amplitude: number,
        rise: (u: number) => number,
        radius = mouthR,
    ) => {
        const halfHeight = thickness + amplitude;
        decal(owner, {
            dir,
            radius,
            halfWidth,
            halfHeight,
            inside: (u, vv) => {
                const ends = Math.max(0, 1 - Math.abs(u) ** p.mouthShape) ** (1 / p.mouthShape);
                return Math.abs(vv * halfHeight - rise(u)) <= thickness * ends;
            },
            sizeScale: 1,
            color: dark,
        });
    };

    // Outline, a white fill taking most of the area, then the pupil and its glint.
    // Their proportions matter more than any one of them: a thin sclera around a big
    // pupil reads as friendly, a big sclera round a pinprick reads as terrified.
    //
    // Filled decals stacked outward rather than a true annulus: no seam where a ring
    // meets its fill, and the sort can't swap them and flicker.
    const eye = (owner: number, sx: number, look: { wide: number; tall: number; pupil: number; shine: number }) => {
        const eyeDir = faceDir(sx * eyeX, eyeY - headY);
        const w = eyeSize * p.eyeWidth * look.wide;
        const h = eyeSize * p.eyeTall * look.tall;
        decal(owner, { dir: eyeDir, radius: faceR * 1.005, halfWidth: w, halfHeight: h, inside: eyeOutline, color: dark });
        // A CONSTANT inset, not a scale factor: scaling a tall outline leaves the rim
        // thicker top and bottom than at the sides.
        const rim = eyeSize * p.eyeOutline;
        decal(owner, {
            dir: eyeDir,
            radius: faceR * 1.012,
            halfWidth: Math.max(1e-4, w - rim),
            halfHeight: Math.max(1e-4, h - rim),
            inside: eyeOutline,
            color: sclera,
        });
        const pupilW = eyeSize * p.eyeWidth * look.pupil;
        const pupilH = eyeSize * p.eyeTall * look.pupil;
        const pupilY = eyeY - headY + eyeSize * p.pupilY * look.tall;
        decal(owner, {
            dir: faceDir(sx * eyeX, pupilY),
            radius: faceR * 1.02,
            halfWidth: pupilW,
            halfHeight: pupilH,
            inside: superellipse(2),
            color: dark,
        });
        // The glint. Up and to the same side on BOTH eyes — it's a reflection of one
        // light, and mirroring it makes them look cross-eyed. A second, smaller one
        // lower down is pure cartoon, and most of what makes these read as cute.
        if (look.shine > 0) {
            for (const [ox, oy, size] of [
                [0.38, 0.42, 1],
                [-0.3, -0.38, 0.45],
            ]) {
                const r = pupilW * look.shine * size;
                decal(owner, {
                    dir: faceDir(sx * eyeX + pupilW * ox, pupilY + pupilH * oy),
                    radius: faceR * 1.028,
                    halfWidth: r,
                    halfHeight: r,
                    inside: superellipse(2),
                    color: sclera,
                });
            }
        }
    };

    // A rounded BAR, not an ellipse — squarer ends give it weight. The inner end
    // sits lower, which is most of the expression; negative angles lift it instead.
    const brow = (owner: number, sx: number, gap: number, angle: number) =>
        decal(owner, {
            dir: faceDir(sx * eyeX * 1.04, eyeY - headY + eyeSize * gap),
            radius: faceR * 1.015,
            halfWidth: eyeSize * p.browWidth,
            halfHeight: eyeSize * p.browThickness,
            roll: sx * angle,
            inside: superellipse(p.browShape),
            color: hair,
        });

    const mouthDir = faceDir(0, headRadius * p.mouthY);
    const mouthThick = headRadius * p.mouthThickness;
    // mouthCurve > 0 lifts the corners into a smile; 0 leaves the flat slot.
    const smile = (owner: number) => {
        const bend = headRadius * p.mouthCurve;
        stroke(owner, mouthDir, headRadius * p.mouthWidth, mouthThick, Math.abs(bend) / 2, (u) => bend * (u * u - 0.5));
    };

    const faceBone = BONES.length;
    const part = (name: FacePart) => faceBone + FACE_PARTS.indexOf(name);

    for (const sx of [1, -1]) {
        eye(part('eyesOpen'), sx, { wide: 1, tall: 1, pupil: p.pupilSize, shine: p.eyeShine });
        // Wide and tall with pinprick pupils: frightened.
        eye(part('eyesWide'), sx, { wide: 1.12, tall: 1.25, pupil: p.pupilSize * 0.42, shine: p.eyeShine * 1.3 });

        // Shut, as a little arch — the ^ ^ of a contented squint, which reads as a
        // smile with the eyes rather than as someone nodding off.
        const arch = eyeSize * p.eyeTall * 0.45;
        stroke(
            part('eyesShut'),
            faceDir(sx * eyeX, eyeY - headY),
            eyeSize * p.eyeWidth * 1.05,
            eyeSize * 0.13,
            arch / 2,
            (u) => -arch * (u * u - 0.5),
            faceR * 1.012,
        );

        // An X for each eye. Two bars, clipped to a disc so the arms finish round
        // rather than as the corners of a square.
        const size = eyeSize * Math.min(p.eyeWidth, p.eyeTall) * 1.05;
        decal(part('eyesCrossed'), {
            dir: faceDir(sx * eyeX, eyeY - headY),
            radius: faceR * 1.012,
            halfWidth: size,
            halfHeight: size,
            inside: (u, vv) => (Math.abs(u - vv) < 0.3 || Math.abs(u + vv) < 0.3) && u * u + vv * vv < 1.15,
            color: dark,
        });

        brow(part('browsCalm'), sx, p.browGap, p.browAngle);
        // Shot up and tilted to worry — inner ends raised.
        brow(part('browsWorried'), sx, p.browGap * 1.4, -0.4);
        brow(part('browsDizzy'), sx, p.browGap * 1.15, -0.25);
    }

    smile(part('mouthSmile'));
    // A small round "o".
    decal(part('mouthO'), {
        dir: faceDir(0, headRadius * (p.mouthY - 0.02)),
        radius: mouthR,
        halfWidth: headRadius * 0.055,
        halfHeight: headRadius * 0.075,
        inside: superellipse(2),
        sizeScale: 1,
        color: dark,
    });
    // A wobble: one and a bit waves across the mouth.
    const wobble = headRadius * 0.022;
    stroke(
        part('mouthWobble'),
        mouthDir,
        headRadius * p.mouthWidth * 1.1,
        mouthThick,
        wobble,
        (u) => wobble * Math.sin(u * Math.PI * 2.5),
    );

    // Rosy cheeks, out and down from each eye, on every face. Just proud of the skin
    // and under everything else, so a big blush can't cover the eyes.
    if (p.blushStrength > 0) {
        for (const sx of [1, -1]) {
            decal(HEAD, {
                dir: faceDir(sx * eyeX * 1.4, eyeY - headY - eyeSize * 1.35),
                radius: faceR * 1.003,
                halfWidth: eyeSize * p.blushSize,
                halfHeight: eyeSize * p.blushSize * 0.6,
                inside: superellipse(2),
                color: blush,
            });
        }
    }

    // Nose: barely there, just a soft shadow under the eyes.
    addSphere(
        shell,
        v(0, headY - headRadius * 0.12, faceR * 0.97),
        headRadius * p.noseSize,
        p.spacing * 0.7,
        skin.clone().multiplyScalar(0.92),
        HEAD,
    );

    // Arms: short sleeve on the upper arm, skin below, mitten hand.
    for (const [upper, fore, sx] of [
        [ARM_L, FORE_L, 1],
        [ARM_R, FORE_R, -1],
    ] as const) {
        const shoulder = v(sx * shoulderX, shoulderY - p.armDrop, 0);
        const elbowP = v(sx * elbow.x, elbow.y, 0);
        const handP = v(sx * hand.x, hand.y, 0);
        // One continuous tube, shoulder to wrist, with NO caps at the elbow: two
        // capsules meeting there interpenetrate over a whole limb radius, and any
        // colour change across that overlap is smeared by the geometry.
        addCapsule(shell, shoulder, elbowP, limbRadius * 1.04, limbRadius, p.spacing, skin, upper, {
            capA: 'none',
            capB: 'none',
            layers: p.layers,
        });
        addCapsule(shell, elbowP, handP, limbRadius, limbRadius * 0.92, p.spacing, skin, fore, {
            capA: 'none',
            capB: 'none',
            layers: p.layers,
        });
        addSphere(shell, handP, limbRadius * 1.45, p.spacing, skin, fore, { layers: p.layers });

        // The sleeve is fabric OVER that arm, cut with a flat ring — what a short
        // sleeve is, and a hard edge instead of a blend between two colours.
        const sleeveEnd = shoulder.clone().lerp(elbowP, 0.42);
        addCapsule(shell, shoulder, sleeveEnd, limbRadius * 1.18, limbRadius * 1.12, p.spacing, shirt, upper, {
            capA: 'round',
            capB: 'flat',
            innerB: limbRadius * 0.98,
            layers: p.layers,
        });
    }

    // Legs: trousers to the ankle, then a shoe.
    for (const [thigh, shin, sx] of [
        [THIGH_L, SHIN_L, 1],
        [THIGH_R, SHIN_R, -1],
    ] as const) {
        const hipP = v(sx * hipX, crotchY + 0.02, 0);
        const kneeP = v(sx * hipX, kneeY, 0);
        const ankleP = v(sx * hipX, 0.07, 0);
        addCapsule(shell, hipP, kneeP, limbRadius * 1.3, limbRadius * 1.12, p.spacing, trousers, thigh, {
            // No cap: the loft above closes this off, and a rounded one breaches the hem.
            capA: 'none',
            capB: 'none',
            layers: p.layers,
        });
        addCapsule(shell, kneeP, ankleP, limbRadius * 1.12, limbRadius, p.spacing, trousers, shin, {
            capA: 'none',
            capB: 'none',
            layers: p.layers,
        });
        // Shoe: an ellipsoid pushed forward, so there's a toe.
        addSphere(shell, v(sx * hipX, 0.045, 0.035), limbRadius * 1.5, p.spacing, shoe, shin, {
            radii: v(limbRadius * 1.25, limbRadius * 0.85, limbRadius * 2.1),
            layers: p.layers,
        });
    }

    // --- Into a SplatMesh ----------------------------------------------------
    let lowest = Number.POSITIVE_INFINITY;
    for (const c of shell.centers) lowest = Math.min(lowest, c.y);
    // A splat is a disc, not a point, so its visible edge reaches past its centre.
    const feetY = lowest - p.spacing * p.overlap;

    // Not `constructSplats`: that option initialises the mesh ASYNC, and the
    // SplatSkinning below needs numSplats on the next line. pushSplat leaves the two
    // lines after the loop to the caller.
    const mesh = new SplatMesh({});
    for (let i = 0; i < shell.centers.length; i++) {
        mesh.pushSplat(shell.centers[i], shell.scales[i], shell.quats[i], 1.0, shell.colors[i]);
    }
    mesh.numSplats = mesh.packedSplats?.numSplats ?? 0;
    if (mesh.packedSplats) mesh.packedSplats.needsUpdate = true;

    const skinning = new SplatSkinning({
        mesh,
        numSplats: mesh.numSplats,
        numBones: BONES.length + FACE_PARTS.length,
        mode: SplatSkinningMode.DUAL_QUATERNION,
    });

    const restQuat = new THREE.Quaternion();
    for (let b = 0; b < BONES.length; b++) skinning.setRestQuatPos(b, restQuat, BONES[b].head);
    // Face bones rest exactly where the head does, so at rest they ARE the head.
    for (let k = 0; k < FACE_PARTS.length; k++) skinning.setRestQuatPos(faceBone + k, restQuat, BONES[HEAD].head);

    // Distance falloff, BIASED toward the bone that authored each splat — which is
    // what keeps the hands from grabbing the hips as the arms swing past them.
    const indices = new THREE.Vector4();
    const weights = new THREE.Vector4();
    for (let i = 0; i < shell.centers.length; i++) {
        if (shell.owners[i] >= faceBone) {
            // Face features belong wholly to their face bone: blending one with its
            // neighbours would leave half of a hidden expression showing.
            indices.set(shell.owners[i], 0, 0, 0);
            weights.set(1, 0, 0, 0);
        } else {
            weightsForPoint(shell.centers[i], BONES, indices, weights, shell.owners[i]);
        }
        skinning.setSplatBones(i, indices, weights);
    }
    skinning.skinTexture.needsUpdate = true;

    mesh.skinning = skinning;
    mesh.updateGenerator();

    const skeleton = initSkeleton(BONES);

    return {
        kind: 'avatar',
        params: p,
        feetY,
        mesh,
        skinning,
        skeleton,
        expression: 'happy',
        faceBone,
        dispose() {
            skinning.skinTexture.dispose();
            skinning.boneTexture.dispose();
            mesh.dispose();
        },
    };
}

const xAxis = new THREE.Vector3(1, 0, 0);
const yAxis = new THREE.Vector3(0, 1, 0);
const zAxis = new THREE.Vector3(0, 0, 1);
const armSet = new THREE.Quaternion();

/** Advance the walk cycle and push the pose through to the splats. */
/** Peak thigh swing, in radians. Stride length follows from this and leg length. */
const THIGH_SWING = 0.52;

/**
 * How far one step carries the body. A leg is a pendulum, so the foot's fore-aft
 * travel is 2 x legLength x sin(swing), and the gait rate has to be a CONSEQUENCE of
 * this and speed. Any constant instead and the feet slide, which is "gliding".
 */
export function strideLength(params: AvatarParams): number {
    return 2 * params.hipY * Math.sin(THIGH_SWING);
}

/**
 * Pose the avatar at `phase` radians through its gait cycle (2 steps per 2xPI).
 *
 * `gait` fades the walk out without freezing it: at 0 every swing term is zero,
 * landing on the authored rest stance with a breath in place of the stride. The
 * cycle has no standing pose of its own — no phase has both knees straight — so
 * stopping the phase instead leaves someone frozen mid-step.
 */
export function poseAvatar(avatar: Avatar, phase: number, gait = 1): void {
    const { skeleton } = avatar;
    const swing = Math.sin(phase) * gait;
    const pose = skeleton.pose;
    const legLength = avatar.params.hipY;

    // Positive swings the leg BACK: left is rearmost at PI/2, forward by 3PI/2.
    pose[THIGH_L].setFromAxisAngle(xAxis, swing * THIGH_SWING);
    pose[THIGH_R].setFromAxisAngle(xAxis, -swing * THIGH_SWING);

    // The knee bends during SWING-THROUGH, to lift the foot clear — not at heel
    // strike, when the leg should be straight and taking weight.
    const flexL = Math.max(0, -Math.cos(phase)) ** 1.3 * gait;
    const flexR = Math.max(0, Math.cos(phase)) ** 1.3 * gait;
    pose[SHIN_L].setFromAxisAngle(xAxis, flexL * 0.95);
    pose[SHIN_R].setFromAxisAngle(xAxis, flexR * 0.95);

    // A slight outward set so they clear the body. That set is part of the STANCE,
    // not the walk, so it survives the gait fading to nothing.
    pose[ARM_L].setFromAxisAngle(xAxis, -swing * 0.42);
    pose[ARM_R].setFromAxisAngle(xAxis, swing * 0.42);
    // Reused scratch: `new Quaternion()` here is two allocations per avatar per frame.
    pose[ARM_L].multiply(armSet.setFromAxisAngle(zAxis, -0.12));
    pose[ARM_R].multiply(armSet.setFromAxisAngle(zAxis, 0.12));
    pose[FORE_L].setFromAxisAngle(xAxis, 0.18 + 0.12 * swing);
    pose[FORE_R].setFromAxisAngle(xAxis, 0.18 - 0.12 * swing);

    pose[PELVIS].setFromAxisAngle(yAxis, -swing * 0.13);
    pose[CHEST].setFromAxisAngle(yAxis, swing * 0.2);
    // The big head lags the shoulders: cheap secondary motion, and what stops the
    // walk reading as a rigid puppet. Standing, it becomes a slow look-around.
    const still = 1 - gait;
    pose[HEAD].setFromAxisAngle(yAxis, -Math.sin(phase - 0.45) * 0.14 * gait + Math.sin(phase * 0.37) * 0.07 * still);

    // Twice per cycle: highest as the legs pass, lowest split widest, since a split
    // stance is geometrically shorter. Without it they're a torso on a conveyor belt.
    const bob = Math.abs(Math.cos(phase)) * legLength * 0.075 * gait;
    // ...and a sway onto whichever foot is carrying the weight.
    const sway = swing * legLength * 0.045;
    // Standing, all that's left is breathing.
    const breath = Math.sin(phase * 0.5) * legLength * 0.014 * still;
    skeleton.rootOffset.set(sway, bob - legLength * 0.037 * gait + breath, 0);

    poseSkeleton(skeleton);
}

/**
 * Pose and draw. The crowd splits the two apart, because a walker getting back up
 * has to mix this pose with its sprawl before anything reaches the screen.
 */
export function updateAvatar(avatar: Avatar, phase: number): void {
    poseAvatar(avatar, phase);
    pushAvatar(avatar);
}

const faceRest = new THREE.Quaternion();
const facePos = new THREE.Vector3();

/**
 * Hand the pose to Spark, face included. Every face bone copies the head's
 * transform; all but the current expression's parts are also pushed back along the head's
 * own -Z, into the skull. Use this rather than `pushSkeleton`, which knows nothing
 * of faces and would leave them at rest while the head walks off.
 */
export function pushAvatar(avatar: Avatar): void {
    const { skeleton, skinning } = avatar;
    const headQuat = skeleton.worldQuat[HEAD];
    const showing = EXPRESSION_PARTS[avatar.expression];
    for (let k = 0; k < FACE_PARTS.length; k++) {
        facePos.set(0, 0, showing.includes(FACE_PARTS[k]) ? 0 : -avatar.params.headRadius * FACE_HIDE_DEPTH);
        facePos.applyQuaternion(headQuat).add(skeleton.worldPos[HEAD]);
        setBoneWorld(skinning, avatar.faceBone + k, faceRest, skeleton.bones[HEAD].head, headQuat, facePos);
    }
    pushSkeleton(skeleton, skinning);
}
