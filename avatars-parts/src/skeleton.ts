/**
 * The bones, drawn over the splats: a line from each joint to its tip, moved by the
 * same transforms the splats are. A way of seeing the skinning, not part of it.
 */

import type { SplatMesh } from '@sparkjsdev/spark';
import { type Mat4, vec3 } from 'math';
import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Bone } from './4-skinning';

export const SKELETON = 'skeleton';

const _end = vec3.create();
const _at = new THREE.Matrix4();

export function skeleton(mesh: SplatMesh, bones: Bone[]) {
    const ink = { color: 0x00a6ff, depthTest: false, transparent: true };
    const lines = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ ...ink, linewidth: 4 }));
    const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.018), new THREE.MeshBasicMaterial(ink), bones.length);
    for (const part of [lines, joints]) {
        part.frustumCulled = false;
        part.renderOrder = 999;
    }
    const group = new THREE.Group().add(lines, joints);
    group.name = SKELETON;
    mesh.add(group);

    // The line geometry reads `ends` directly: write into it, then flag it.
    const ends = new Float32Array(bones.length * 6);
    lines.geometry.setPositions(ends);
    const endsBuffer = (lines.geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute).data;
    return (posed: Mat4[]) => {
        for (let i = 0; i < bones.length; i++) {
            ends.set(vec3.transformMat4(_end, bones[i].joint, posed[i]), i * 6);
            ends.set(vec3.transformMat4(_end, bones[i].tip, posed[i]), i * 6 + 3);
            joints.setMatrixAt(i, _at.makeTranslation(ends[i * 6], ends[i * 6 + 1], ends[i * 6 + 2]));
        }
        endsBuffer.needsUpdate = true;
        joints.instanceMatrix.needsUpdate = true;
    };
}
