import { SplatMesh, SplatSkinning, SplatSkinningMode } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { applySkeleton, type BoneDef, initSkeleton, type Skeleton, weightsForPoint } from './bones';
import { splatColorHSL } from './shell';

/**
 * A stick figure made of splats, rigged and walking.
 *
 * The step up from the one-joint tube isn't the bone count — it's that the weights
 * come from DISTANCE TO A BONE rather than a hand-written rule about height, which
 * is the part that generalises to a scan.
 *
 * The catch this rig can't show you is that the SKELETON wouldn't carry over: here
 * the bones were authored to match geometry generated from them, so they're in the
 * right places for free.
 *
 * Splats are elongated along whichever bone spawned them, for the same reason as the
 * tube: it makes a missing orientation transform obvious rather than subtle.
 */

const HIP_Y = 0.95;
const SHOULDER_Y = 1.42;

function v(x: number, y: number, z: number) {
    return new THREE.Vector3(x, y, z);
}

// Bones are authored world-aligned in the rest pose, so a bone's rest orientation is
// the identity and `head` is simply the joint it pivots about.
const BONES: BoneDef[] = [
    { name: 'pelvis', parent: -1, head: v(0, HIP_Y, 0), tail: v(0, SHOULDER_Y, 0), radius: 0.15 },
    { name: 'chest', parent: 0, head: v(0, SHOULDER_Y, 0), tail: v(0, 1.62, 0), radius: 0.15 },
    { name: 'head', parent: 1, head: v(0, 1.62, 0), tail: v(0, 1.86, 0), radius: 0.13 },

    { name: 'armL', parent: 1, head: v(0.19, SHOULDER_Y, 0), tail: v(0.42, 1.18, 0), radius: 0.075 },
    { name: 'foreL', parent: 3, head: v(0.42, 1.18, 0), tail: v(0.6, 0.93, 0), radius: 0.065 },
    { name: 'armR', parent: 1, head: v(-0.19, SHOULDER_Y, 0), tail: v(-0.42, 1.18, 0), radius: 0.075 },
    { name: 'foreR', parent: 5, head: v(-0.42, 1.18, 0), tail: v(-0.6, 0.93, 0), radius: 0.065 },

    { name: 'thighL', parent: 0, head: v(0.11, HIP_Y, 0), tail: v(0.13, 0.52, 0), radius: 0.095 },
    { name: 'shinL', parent: 7, head: v(0.13, 0.52, 0), tail: v(0.13, 0.08, 0), radius: 0.075 },
    { name: 'thighR', parent: 0, head: v(-0.11, HIP_Y, 0), tail: v(-0.13, 0.52, 0), radius: 0.095 },
    { name: 'shinR', parent: 9, head: v(-0.13, 0.52, 0), tail: v(-0.13, 0.08, 0), radius: 0.075 },
];

const RINGS_PER_UNIT = 150; // splat rings per world unit of bone length
const AROUND = 26;

export type Figure = {
    /** Discriminant: these two are otherwise structurally identical. */
    kind: 'figure';
    mesh: SplatMesh;
    skinning: SplatSkinning;
    /** Frees the skinning textures too — mesh.dispose() alone leaves them behind. */
    dispose(): void;
    skeleton: Skeleton;
};

export function initFigure(): Figure {
    const mesh = new SplatMesh({});
    const points: THREE.Vector3[] = [];

    const center = new THREE.Vector3();
    const scales = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const color = new THREE.Color();
    const axis = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3();
    const other = new THREE.Vector3();

    for (let b = 0; b < BONES.length; b++) {
        const bone = BONES[b];
        axis.copy(bone.tail).sub(bone.head);
        const length = axis.length();
        axis.normalize();

        // A frame around the bone, so rings are perpendicular to it whatever
        // direction it points.
        side.copy(Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up)
            .cross(axis)
            .normalize();
        other.copy(axis).cross(side).normalize();

        // Splats point ALONG the bone: the tell for a missing rotation transform.
        quat.setFromUnitVectors(up, axis);

        const rings = Math.max(6, Math.round(length * RINGS_PER_UNIT));
        for (let r = 0; r < rings; r++) {
            const t = r / (rings - 1);
            // Round the ends off slightly so limbs read as capsules, not pipes.
            const taper = Math.sin(Math.PI * THREE.MathUtils.clamp(0.08 + t * 0.84, 0, 1)) ** 0.35;
            const radius = bone.radius * taper;
            for (let a = 0; a < AROUND; a++) {
                const ang = (a / AROUND) * Math.PI * 2;
                center
                    .copy(bone.head)
                    .addScaledVector(axis, t * length)
                    .addScaledVector(side, Math.cos(ang) * radius)
                    .addScaledVector(other, Math.sin(ang) * radius);
                scales.set(0.012, 0.03, 0.012);
                color.copy(splatColorHSL(0.55 - 0.16 * (b / BONES.length), 0.5, 0.42 + 0.22 * t));
                mesh.pushSplat(center, scales, quat, 1.0, color);
                points.push(center.clone());
            }
        }
    }

    mesh.numSplats = mesh.packedSplats?.numSplats ?? 0;
    if (mesh.packedSplats) mesh.packedSplats.needsUpdate = true;

    const skinning = new SplatSkinning({
        mesh,
        numSplats: mesh.numSplats,
        numBones: BONES.length,
        mode: SplatSkinningMode.DUAL_QUATERNION,
    });

    const restQuat = new THREE.Quaternion();
    for (let b = 0; b < BONES.length; b++) {
        skinning.setRestQuatPos(b, restQuat, BONES[b].head);
    }

    // The weights. Note this runs over every splat against every bone — fine here,
    // and still fine at scan scale (a few hundred ms for ~1M splats), because it
    // happens once at load rather than per frame.
    const indices = new THREE.Vector4();
    const weights = new THREE.Vector4();
    for (let i = 0; i < points.length; i++) {
        weightsForPoint(points[i], BONES, indices, weights);
        skinning.setSplatBones(i, indices, weights);
    }
    skinning.skinTexture.needsUpdate = true;

    mesh.skinning = skinning;
    mesh.updateGenerator();

    const skeleton = initSkeleton(BONES);

    return {
        kind: 'figure',
        mesh,
        skinning,
        dispose() {
            skinning.skinTexture.dispose();
            skinning.boneTexture.dispose();
            mesh.dispose();
        },
        skeleton,
    };
}

const xAxis = new THREE.Vector3(1, 0, 0);
const up = new THREE.Vector3(0, 1, 0);
const zAxis = new THREE.Vector3(0, 0, 1);
/** Bone name to index, so the walk cycle reads as names rather than numbers. */
const index = Object.fromEntries(BONES.map((b, i) => [b.name, i])) as Record<string, number>;

/** Advance the walk cycle. */
export function updateFigure(figure: Figure, time: number): void {
    const { skeleton } = figure;
    const step = time * 2.6;
    const swing = Math.sin(step);
    const pose = skeleton.pose;

    // Legs swing in opposition; knees only bend backwards, and mostly on the
    // leg that's travelling forward.
    pose[index.thighL].setFromAxisAngle(xAxis, swing * 0.55);
    pose[index.thighR].setFromAxisAngle(xAxis, -swing * 0.55);
    pose[index.shinL].setFromAxisAngle(xAxis, Math.max(0, -swing) * 0.9);
    pose[index.shinR].setFromAxisAngle(xAxis, Math.max(0, swing) * 0.9);

    // Arms counter-swing the legs, with a little elbow.
    pose[index.armL].setFromAxisAngle(xAxis, -swing * 0.5);
    pose[index.armR].setFromAxisAngle(xAxis, swing * 0.5);
    pose[index.foreL].setFromAxisAngle(xAxis, (0.5 + 0.35 * swing) * 0.6);
    pose[index.foreR].setFromAxisAngle(xAxis, (0.5 - 0.35 * swing) * 0.6);

    // Torso counter-rotates and leans; the hips bob at twice the step rate,
    // which is what actually sells a walk.
    pose[index.pelvis].setFromAxisAngle(up, -swing * 0.16);
    pose[index.chest].setFromAxisAngle(up, swing * 0.22);
    pose[index.head].setFromAxisAngle(zAxis, -swing * 0.06);
    skeleton.rootOffset.set(0, Math.abs(Math.cos(step)) * 0.045 - 0.02, 0);

    applySkeleton(skeleton, figure.skinning);
}
