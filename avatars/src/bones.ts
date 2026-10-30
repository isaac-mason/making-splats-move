/**
 * Spark's `setBoneQuatPos(i, quat, pos)` stores R = restQuat⁻¹ · quat and t = pos − restPos,
 * and the shader applies v → R·v + t: R turns about the world origin, t is a plain delta.
 * To get v → Rm·(v − restPos) + curPos (Rm = curQuat · restQuat⁻¹), pass
 * quat = restQuat · Rm and pos = restPos + curPos − Rm·restPos. `setBoneWorld` does this.
 */

import * as THREE from 'three';
import type { Skinning } from './splats';

const rmScratch = new THREE.Quaternion();
const quatScratch = new THREE.Quaternion();
const posScratch = new THREE.Vector3();
const rotatedRest = new THREE.Vector3();

export function setBoneWorld(
    skinning: Skinning,
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

export type BoneDef = {
    name: string;
    parent: number;
    head: THREE.Vector3;
    tail: THREE.Vector3;
    radius: number;
};

export type Skeleton = {
    bones: BoneDef[];
    pose: THREE.Quaternion[];
    rootOffset: THREE.Vector3;
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

export function poseSkeleton(skeleton: Skeleton): void {
    const { bones, pose, worldQuat, worldPos } = skeleton;
    for (let i = 0; i < bones.length; i++) {
        const bone = bones[i];
        if (bone.parent < 0) {
            worldQuat[i].copy(pose[i]);
            worldPos[i].copy(bone.head).add(skeleton.rootOffset);
        } else {
            worldQuat[i].copy(worldQuat[bone.parent]).multiply(pose[i]);
            offsetScratch.copy(bone.head).sub(bones[bone.parent].head).applyQuaternion(worldQuat[bone.parent]);
            worldPos[i].copy(worldPos[bone.parent]).add(offsetScratch);
        }
    }
}

export function pushSkeleton(skeleton: Skeleton, skinning: Skinning): void {
    const { bones, worldQuat, worldPos } = skeleton;
    for (let i = 0; i < bones.length; i++) {
        setBoneWorld(skinning, i, restIdentity, bones[i].head, worldQuat[i], worldPos[i]);
    }
    skinning.updateBones();
}

export function weightsForPoint(
    point: THREE.Vector3,
    bones: BoneDef[],
    outIndices: THREE.Vector4,
    outWeights: THREE.Vector4,
    /** Favours the bone the splat was built as part of: distance alone mis-assigns a hand passing a hip. */
    owner?: number,
): void {
    bestWeight[0] = bestWeight[1] = bestWeight[2] = bestWeight[3] = 0;
    bestIndex[0] = bestIndex[1] = bestIndex[2] = bestIndex[3] = 0;

    for (let i = 0; i < bones.length; i++) {
        const d = distanceToSegment(point, bones[i].head, bones[i].tail);
        const sigma = bones[i].radius * 1.6;
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
