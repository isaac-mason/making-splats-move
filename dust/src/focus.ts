import { type SplatData, Splats } from '@sparkjsdev/radix';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PICK = { minOpacity: 0.3, reach: 1.5, minDistance: 0.3 };
const PULL_SECONDS = 0.25;

export type Focus = {
    update(dt: number): number;
};

export function createFocus(
    data: SplatData,
    scale: number,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
): Focus {
    const solid = readSolidSplats(data, scale);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovering = false;
    let moved = false;
    let picked = 0;
    let focal = camera.position.distanceTo(controls.target);

    domElement.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'mouse') return;
        const rect = domElement.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
        hovering = true;
        moved = true;
    });
    domElement.addEventListener('pointerleave', () => {
        hovering = false;
    });

    const lastCamera = new THREE.Vector3();
    const lastQuaternion = new THREE.Quaternion();
    const forward = new THREE.Vector3();

    return {
        update(dt) {
            if (hovering) {
                const cameraMoved =
                    lastCamera.distanceToSquared(camera.position) > 1e-4 ||
                    1 - Math.abs(lastQuaternion.dot(camera.quaternion)) > 1e-6;
                if (moved || cameraMoved) {
                    raycaster.setFromCamera(pointer, camera);
                    const hit = nearestHit(solid, raycaster.ray);
                    if (hit !== undefined) picked = hit * raycaster.ray.direction.dot(camera.getWorldDirection(forward));
                    lastCamera.copy(camera.position);
                    lastQuaternion.copy(camera.quaternion);
                    moved = false;
                }
            }
            const goal = hovering && picked > 0 ? picked : camera.position.distanceTo(controls.target);
            focal += (goal - focal) * (1 - 0.5 ** (dt / PULL_SECONDS));
            return focal;
        },
    };
}

type SolidSplats = { count: number; centers: Float32Array; radii: Float32Array };

function readSolidSplats(data: SplatData, scale: number): SolidSplats {
    const decode = Splats.decoder(Splats.get(data).bundle);
    const s = Splats.makeExtSplat();
    const centers = new Float32Array(data.count * 3);
    const radii = new Float32Array(data.count);
    let count = 0;
    for (let i = 0; i < data.count; i++) {
        decode(i, s);
        if (s.opacity < PICK.minOpacity) continue;
        centers.set([s.center.x * scale, s.center.y * scale, s.center.z * scale], count * 3);
        radii[count] = Math.max(s.scales.x, s.scales.y, s.scales.z) * scale * PICK.reach;
        count++;
    }
    return { count, centers: centers.subarray(0, count * 3), radii: radii.subarray(0, count) };
}

function nearestHit({ count, centers, radii }: SolidSplats, ray: THREE.Ray): number | undefined {
    const { x: ox, y: oy, z: oz } = ray.origin;
    const { x: dx, y: dy, z: dz } = ray.direction;
    let nearest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
        const px = centers[i * 3] - ox;
        const py = centers[i * 3 + 1] - oy;
        const pz = centers[i * 3 + 2] - oz;
        const along = px * dx + py * dy + pz * dz;
        if (along < PICK.minDistance || along >= nearest) continue;
        const r = radii[i];
        if (px * px + py * py + pz * pz - along * along < r * r) nearest = along;
    }
    return Number.isFinite(nearest) ? nearest : undefined;
}
