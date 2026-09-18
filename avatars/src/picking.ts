import type { World } from 'crashcat';
import * as THREE from 'three';
import type { Crowd, Walker } from './crowd';
import { pickBody, puppetOwns } from './physics';

/**
 * Pointer to walker, against the physics capsules rather than the splats.
 *
 * Three's raycaster does work on a SplatMesh, and it's the wrong tool here: Spark
 * raycasts the packed splat array, which is the REST pose, because skinning happens
 * in the shader. So it thinks every avatar is permanently standing to attention — an
 * arm swung forward isn't where it says, and someone lying on the ground isn't there
 * at all. The capsules match the drawn pose every frame.
 */

/** Metres a click reaches: past the far side of the square. */
const PICK_RANGE = 60;

export type Pick = {
    walker: Walker;
    index: number;
    /** Where on them the ray landed, in world space. */
    point: THREE.Vector3;
};

const ndc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const point = new THREE.Vector3();

/** The ray under the pointer. Shared, so it's live only until the next call. */
export function pointerRay(
    camera: THREE.Camera,
    domElement: HTMLElement,
    event: { clientX: number; clientY: number },
): THREE.Ray {
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
}

export function pickWalker(
    world: World,
    camera: THREE.Camera,
    crowd: Crowd,
    domElement: HTMLElement,
    event: { clientX: number; clientY: number },
): Pick | null {
    const ray = pointerRay(camera, domElement, event);
    const body = pickBody(world, ray.origin, ray.direction, PICK_RANGE, point);
    if (!body) return null;
    const index = crowd.walkers.findIndex((w) => puppetOwns(w.puppet, body));
    if (index < 0) return null;
    return { walker: crowd.walkers[index], index, point: point.clone() };
}

/** Click-to-select against the crowd. Reports null when the click hit nothing. */
export function attachPicking(
    world: World,
    camera: THREE.Camera,
    crowd: Crowd,
    domElement: HTMLElement,
    onPick: (pick: Pick | null) => void,
): void {
    domElement.addEventListener('click', (event) => {
        onPick(pickWalker(world, camera, crowd, domElement, event));
    });
}
