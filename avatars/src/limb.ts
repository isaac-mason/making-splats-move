import { SplatMesh, SplatSkinning, SplatSkinningMode } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { setBoneWorld } from './bones';
import { splatColorHSL } from './shell';

/**
 * A tube of splats across one joint — the smallest thing that answers "does
 * Spark's SplatSkinning actually work?".
 *
 * It's deliberately not a character. Everything here is chosen so that a bug is
 * unmissable rather than merely suspicious:
 *
 *   - Uniform ring lattice, so a hole or a pinch at the joint stands out.
 *   - Splats ELONGATED ALONG THE LIMB. Skinning has to transform each splat's
 *     orientation, not just its centre; if it doesn't, these stay pointing at the
 *     sky while the limb swings sideways, and the bend smears into crosshatch.
 *     With round splats you'd never see the difference.
 *   - Colour banded up the length, so twist and stretch are readable.
 */

const LENGTH = 2.0; // tube runs from y=0 to y=LENGTH
const RADIUS = 0.22;
const RINGS = 150; // lattice resolution along the tube …
const AROUND = 44; // … and around it

/** Where the two bones meet, as a height up the tube. */
export const JOINT_Y = LENGTH * 0.5;
/** How far the weights feather either side of the joint. */
const BLEND = 0.26;

export type Limb = {
    mesh: SplatMesh;
    skinning: SplatSkinning;
    /** Frees the skinning textures too — mesh.dispose() alone leaves them behind. */
    dispose(): void;
};

export function initLimb(): Limb {
    const mesh = new SplatMesh({});

    const center = new THREE.Vector3();
    const scales = new THREE.Vector3();
    const quaternion = new THREE.Quaternion(); // identity: long axis is +Y, along the tube
    const color = new THREE.Color();

    for (let r = 0; r < RINGS; r++) {
        const t = r / (RINGS - 1);
        const y = t * LENGTH;
        // Bands every tenth of the length — a twist shows as the bands shearing.
        const band = Math.floor(t * 10) % 2 === 0 ? 0.0 : 0.22;
        for (let a = 0; a < AROUND; a++) {
            const ang = (a / AROUND) * Math.PI * 2;
            center.set(Math.cos(ang) * RADIUS, y, Math.sin(ang) * RADIUS);
            // Long axis along the tube (+Y). This is the tell: see the note above.
            scales.set(0.011, 0.055, 0.011);
            color.copy(splatColorHSL(0.58 - 0.12 * t + band, 0.55, 0.55));
            mesh.pushSplat(center, scales, quaternion, 1.0, color);
        }
    }

    mesh.numSplats = mesh.packedSplats?.numSplats ?? 0;
    if (mesh.packedSplats) mesh.packedSplats.needsUpdate = true;

    // Dual quaternion, not linear blend: Spark's LBS path refuses to run on a plain
    // Gsplat (it throws, demanding covSplats) precisely because linear-blending an
    // anisotropic Gaussian is only meaningful on the full covariance. DQS also
    // conserves volume, which is what avoids the candy-wrapper collapse at a joint.
    const skinning = new SplatSkinning({
        mesh,
        numSplats: mesh.numSplats,
        numBones: 2,
        mode: SplatSkinningMode.DUAL_QUATERNION,
    });

    // Rest pose. Bone 0 owns the lower half, bone 1 the upper; both start
    // unrotated, so the rest pose is the identity transform and the tube is
    // straight until something moves.
    const lowerPivot = new THREE.Vector3(0, 0, 0);
    const upperPivot = new THREE.Vector3(0, JOINT_Y, 0);
    const identity = new THREE.Quaternion();
    skinning.setRestQuatPos(0, identity, lowerPivot);
    skinning.setRestQuatPos(1, identity, upperPivot);

    // WEIGHTS. Nothing in a splat file provides these, so they have to be derived —
    // here from height alone, feathered across the joint. (A real rig wants distance
    // to a bone capsule; this is the one-joint version of the same idea.)
    const indices = new THREE.Vector4(0, 1, 0, 0);
    const weights = new THREE.Vector4();
    let splat = 0;
    for (let r = 0; r < RINGS; r++) {
        const y = (r / (RINGS - 1)) * LENGTH;
        const upper = THREE.MathUtils.smoothstep(y, JOINT_Y - BLEND, JOINT_Y + BLEND);
        for (let a = 0; a < AROUND; a++) {
            weights.set(1 - upper, upper, 0, 0);
            skinning.setSplatBones(splat++, indices, weights);
        }
    }
    skinning.skinTexture.needsUpdate = true;

    // `skinning` is a plain property read while the generator pipeline is built, so
    // it has to be attached before the rebuild, not after.
    mesh.skinning = skinning;
    mesh.updateGenerator();

    return {
        mesh,
        skinning,
        dispose() {
            skinning.skinTexture.dispose();
            skinning.boneTexture.dispose();
            mesh.dispose();
        },
    };
}

const bendScratch = new THREE.Quaternion();
const bendAxis = new THREE.Vector3(0, 0, 1);
const bendPivot = new THREE.Vector3(0, JOINT_Y, 0);
const bendRest = new THREE.Quaternion();

/** Bend the upper bone by `angle` radians about +Z. */
export function setLimbBend(limb: Limb, angle: number): void {
    bendScratch.setFromAxisAngle(bendAxis, angle);
    // Rest orientation is the identity and the bone only rotates, so the current
    // position is the pivot itself; setBoneWorld does the rest.
    setBoneWorld(limb.skinning, 1, bendRest, bendPivot, bendScratch, bendPivot);
    limb.skinning.updateBones();
}
