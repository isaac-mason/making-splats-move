import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DRIFT_RANGE = 0.45;
const SMOOTHING = 0.6;
const DEADZONE = 0.05;

export type CameraDrift = {
    apply(dt: number): void;
};

export function createCameraDrift(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
): CameraDrift {
    const target = new THREE.Vector2();
    const current = new THREE.Vector2();
    const applied = new THREE.Vector3();

    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const next = new THREE.Vector3();

    let hovering = false;

    const isMouse = (event: PointerEvent) => event.pointerType === 'mouse';

    domElement.addEventListener('pointermove', (event) => {
        if (!isMouse(event)) return;
        if (event.buttons !== 0) {
            hovering = false;
            return;
        }
        const rect = domElement.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
        // Ease in from the deadzone so there's no jump as the cursor leaves centre.
        const length = Math.hypot(x, y);
        const scale = length <= DEADZONE ? 0 : (length - DEADZONE) / (1 - DEADZONE) / length;
        target.set(x * scale, y * scale);
        hovering = true;
    });

    domElement.addEventListener('pointerdown', (event) => {
        if (isMouse(event)) hovering = false;
    });
    domElement.addEventListener('pointerup', (event) => {
        if (isMouse(event)) hovering = true;
    });
    domElement.addEventListener('pointerleave', (event) => {
        if (isMouse(event)) hovering = false;
    });

    return {
        apply(dt) {
            if (!hovering) target.set(0, 0);

            const t = 1 - 0.5 ** (dt / SMOOTHING);
            current.lerp(target, t);

            camera.position.sub(applied);
            controls.update();

            camera.matrixWorld.extractBasis(right, up, next);
            applied
                .set(0, 0, 0)
                .addScaledVector(right, current.x * DRIFT_RANGE)
                .addScaledVector(up, current.y * DRIFT_RANGE);
            camera.position.add(applied);
        },
    };
}
