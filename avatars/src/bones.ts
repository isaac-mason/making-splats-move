/**
 * Posing bones, and a small forward-kinematics skeleton to drive them.
 *
 * Read `setBoneWorld`: Spark's bone API does not mean what it looks like.
 * `setBoneQuatPos(i, quat, pos)` reads as "put bone i at pos, rotated by quat". It
 * isn't. Spark stores
 *
 *     R = restQuat⁻¹ · quat        t = pos − restPos
 *
 * and the shader applies `v → R·v + t`. R rotates about the WORLD ORIGIN and t is a
 * plain translation delta — not the `current · rest⁻¹` matrix skinning normally
 * means. Hand it a joint as `pos` and the limb tears off and orbits.
 *
 * The transform we want is the standard one:
 *
 *     v → Rm·(v − restPos) + curPos,   Rm = curQuat · restQuat⁻¹
 *
 * so pass `quat = restQuat · Rm` and `pos = restPos + curPos − Rm·restPos`. That's
 * all `setBoneWorld` does, and every bone goes through it.
 */

import type { SplatSkinning } from '@sparkjsdev/spark';
import * as THREE from 'three';

// Scratch: this runs per bone, per avatar, per frame.
const rmScratch = new THREE.Quaternion();
const quatScratch = new THREE.Quaternion();
const posScratch = new THREE.Vector3();
const rotatedRest = new THREE.Vector3();

export function setBoneWorld(
    skinning: SplatSkinning,
    bone: number,
    restQuat: THREE.Quaternion,
    restPos: THREE.Vector3,
    curQuat: THREE.Quaternion,
    curPos: THREE.Vector3,
): void {
    rmScratch.copy(restQuat).invert().premultiply(curQuat);
    quatScratch.copy(restQuat).multiply(rmScratch);
    rotatedRest.copy(restPos).applyQuaternion(rmScratch);
    posScratch.copy(restPos).add(curPos).sub(rotatedRest);
    skinning.setBoneQuatPos(bone, quatScratch, posScratch);
}

/** A bone in the rest skeleton: a segment, plus who it hangs off. */
export type BoneDef = {
    name: string;
    /** Index into the bone list, or -1 for the root. */
    parent: number;
    /** Rest-pose endpoints in world space. `head` is the joint it pivots about. */
    head: THREE.Vector3;
    tail: THREE.Vector3;
    /** How far the flesh extends around this segment. Also sets the weight falloff. */
    radius: number;
};

export type Skeleton = {
    bones: BoneDef[];
    /** Per-bone local rotation, relative to the parent. Animate these. */
    pose: THREE.Quaternion[];
    /** Whole-body offset, for a bob or a step. */
    rootOffset: THREE.Vector3;
    /** World transforms, rebuilt by poseSkeleton (or read out of the ragdoll). */
    worldQuat: THREE.Quaternion[];
    worldPos: THREE.Vector3[];
};

export function initSkeleton(bones: BoneDef[]): Skeleton {
    return {
        bones,
        pose: bones.map(() => new THREE.Quaternion()),
        rootOffset: new THREE.Vector3(),
        worldQuat: bones.map(() => new THREE.Quaternion()),
        worldPos: bones.map(() => new THREE.Vector3()),
    };
}

const restIdentity = new THREE.Quaternion(); // every bone rests world-aligned
const offsetScratch = new THREE.Vector3();

/**
 * Forward kinematics: fill in every bone's world transform. Separate from the push
 * because a ragdoll writes the same arrays from its bodies instead.
 */
export function poseSkeleton(skeleton: Skeleton): void {
    const { bones, pose, worldQuat, worldPos } = skeleton;
    for (let i = 0; i < bones.length; i++) {
        const bone = bones[i];
        if (bone.parent < 0) {
            worldQuat[i].copy(pose[i]);
            worldPos[i].copy(bone.head).add(skeleton.rootOffset);
        } else {
            // Bones rest world-aligned, so there's no rest orientation to unwind.
            worldQuat[i].copy(worldQuat[bone.parent]).multiply(pose[i]);
            offsetScratch.copy(bone.head).sub(bones[bone.parent].head).applyQuaternion(worldQuat[bone.parent]);
            worldPos[i].copy(worldPos[bone.parent]).add(offsetScratch);
        }
    }
}

/** Hand the current world transforms to Spark. */
export function pushSkeleton(skeleton: Skeleton, skinning: SplatSkinning): void {
    const { bones, worldQuat, worldPos } = skeleton;
    for (let i = 0; i < bones.length; i++) {
        setBoneWorld(skinning, i, restIdentity, bones[i].head, worldQuat[i], worldPos[i]);
    }
    skinning.updateBones();
}

/**
 * Bone weights by distance to each bone's segment, with a Gaussian falloff scaled by
 * the bone's radius so a thick thigh claims further than a thin forearm. The best
 * four (all Spark stores), normalised.
 */
export function weightsForPoint(
    point: THREE.Vector3,
    bones: BoneDef[],
    outIndices: THREE.Vector4,
    outWeights: THREE.Vector4,
    /**
     * The bone this splat was built as part of, favoured over its neighbours. Distance
     * alone gets it wrong where a hand passes a hip, and the splat leaves with the hip.
     */
    owner?: number,
): void {
    // Insertion into a fixed top four: this runs for every splat, so nothing allocates.
    bestWeight[0] = bestWeight[1] = bestWeight[2] = bestWeight[3] = 0;
    bestIndex[0] = bestIndex[1] = bestIndex[2] = bestIndex[3] = 0;

    for (let i = 0; i < bones.length; i++) {
        const d = distanceToSegment(point, bones[i].head, bones[i].tail);
        const sigma = bones[i].radius * 1.6;
        // Neighbours still get a say — that's what feathers the joints.
        const bias = owner === undefined || i === owner ? 1 : OTHER_BONE_BIAS;
        const w = Math.exp(-((d / sigma) ** 2)) * bias;
        if (w <= bestWeight[3]) continue;
        let slot = 3;
        while (slot > 0 && bestWeight[slot - 1] < w) {
            bestWeight[slot] = bestWeight[slot - 1];
            bestIndex[slot] = bestIndex[slot - 1];
            slot--;
        }
        bestWeight[slot] = w;
        bestIndex[slot] = i;
    }

    const total = bestWeight[0] + bestWeight[1] + bestWeight[2] + bestWeight[3] || 1;
    outIndices.set(bestIndex[0], bestIndex[1], bestIndex[2], bestIndex[3]);
    outWeights.set(bestWeight[0] / total, bestWeight[1] / total, bestWeight[2] / total, bestWeight[3] / total);
}

const OTHER_BONE_BIAS = 0.34;
const bestWeight = new Float64Array(4);
const bestIndex = new Int32Array(4);
const ab = new THREE.Vector3();
const ap = new THREE.Vector3();

function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
    ab.copy(b).sub(a);
    ap.copy(p).sub(a);
    const lengthSq = ab.lengthSq();
    const t = lengthSq > 0 ? THREE.MathUtils.clamp(ap.dot(ab) / lengthSq, 0, 1) : 0;
    return ap.distanceTo(ab.multiplyScalar(t));
}
