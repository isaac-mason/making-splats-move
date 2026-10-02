import { type SplatMesh, SplatSkinning, SplatSkinningMode } from '@sparkjsdev/spark';
import { mat4, quat, type Vec3, type Vec4, vec3, vec4 } from 'math';
import * as THREE from 'three';
import { ANKLE, arm, ELBOW, forearm, HAND, HIP, head, leg, mirror, SHOULDER, torso, upperArm } from './3-body';
import { skeleton } from './skeleton';

const ONE: Vec3 = [1, 1, 1];
const NOWHERE: Vec3 = [0, 0, 0];

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

const swing = (t: number) => Math.sin(t * 4);

const _at = vec3.create();
const _bones = vec4.create();
const _amounts = vec4.create();
const _turn = quat.create();
const _rotation = quat.create();
const _position = vec3.create();
const _quat = new THREE.Quaternion();
const _vector = new THREE.Vector3();
const _bonesV = new THREE.Vector4();
const _amountsV = new THREE.Vector4();

export type Bone = {
    joint: Vec3;
    tip: Vec3;
    axis: Vec3;
    angle: (t: number) => number;
    parent?: number;
    build?: (mesh: SplatMesh) => void;
    weights?: (at: Vec3, bones: Vec4, amounts: Vec4) => void;
};

const BONES: Bone[] = [
    { build: torso, joint: [0, 0.5, 0], tip: [0, 0.88, 0], axis: Y, angle: (t) => swing(t) * 0.08 },
    { build: head, joint: [0, 0.88, 0], tip: [0, 1.5, 0], axis: Z, angle: (t) => Math.sin(t * 2) * 0.12 },
    { build: (m) => arm(m, -1), joint: mirror(SHOULDER, -1), tip: mirror(HAND, -1), axis: X, angle: (t) => swing(t) * 0.6 },
    { build: (m) => upperArm(m, 1), joint: SHOULDER, tip: ELBOW, axis: Z, angle: () => 0.9 },
    { build: (m) => forearm(m, 1), joint: ELBOW, tip: HAND, axis: Z, angle: (t) => 0.85 + Math.sin(t * 7) * 0.25, parent: 3 },
    { build: (m) => leg(m, -1), joint: mirror(HIP, -1), tip: mirror(ANKLE, -1), axis: X, angle: (t) => -swing(t) * 0.5 },
    { build: (m) => leg(m, 1), joint: HIP, tip: ANKLE, axis: X, angle: (t) => swing(t) * 0.5 },
];

export function skin(mesh: SplatMesh, bones: Bone[]) {
    const owner: number[] = [];
    for (const [i, bone] of bones.entries()) {
        bone.build?.(mesh);
        while (owner.length < (mesh.packedSplats?.numSplats ?? 0)) owner.push(i);
    }
    mesh.numSplats = owner.length;

    const skinning = new SplatSkinning({
        mesh,
        numSplats: owner.length,
        numBones: bones.length,
        mode: SplatSkinningMode.DUAL_QUATERNION,
    });
    for (const [i, bone] of bones.entries()) skinning.setRestQuatPos(i, _quat.identity(), _vector.fromArray(bone.joint));
    mesh.packedSplats?.forEachSplat((i, center) => {
        vec4.set(_bones, owner[i], 0, 0, 0);
        vec4.set(_amounts, 1, 0, 0, 0);
        bones[owner[i]].weights?.(center.toArray(_at) as Vec3, _bones, _amounts);
        skinning.setSplatBones(i, _bonesV.fromArray(_bones), _amountsV.fromArray(_amounts));
    });
    skinning.skinTexture.needsUpdate = true;
    mesh.skinning = skinning;

    const posed = bones.map(() => mat4.create());
    return (time: number) => {
        for (let i = 0; i < bones.length; i++) {
            const { joint, axis, angle, parent } = bones[i];
            const pose = posed[i];
            mat4.fromRotationTranslationScaleOrigin(pose, quat.setAxisAngle(_turn, axis, angle(time)), NOWHERE, ONE, joint);
            if (parent !== undefined) mat4.multiply(pose, posed[parent], pose);
            mat4.getRotation(_rotation, pose);
            vec3.add(_position, joint, mat4.getTranslation(_position, pose));
            skinning.setBoneQuatPos(i, _quat.fromArray(_rotation), _vector.fromArray(_position));
        }
        skinning.updateBones();
        return posed;
    };
}

export function animate(mesh: SplatMesh, bones: Bone[]) {
    const pose = skin(mesh, bones);
    const draw = skeleton(mesh, bones);
    return (time: number) => draw(pose(time));
}

export const skinned = (mesh: SplatMesh) => animate(mesh, BONES);
