import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Maximum tilt, in radians, at the very edge of the window. */
const TILT_RANGE = THREE.MathUtils.degToRad(2.5);
const SMOOTHING = 0.6;
const DEADZONE = 0.05;

export type CameraDrift = {
    apply(dt: number, lean?: boolean): void;
    clear(): void;
};

export function createCameraDrift(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
): CameraDrift {
    const target = new THREE.Vector2();
    const current = new THREE.Vector2();

    const euler = new THREE.Euler();
    const offset = new THREE.Quaternion();

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
        apply(dt, lean = true) {
            if (!hovering || !lean) target.set(0, 0);

            const t = 1 - 0.5 ** (dt / SMOOTHING);
            current.lerp(target, t);

            controls.update();

            // After update(), multiplied on the right: a rotation in the camera's own frame.
            euler.set(current.y * TILT_RANGE, -current.x * TILT_RANGE, 0, 'YXZ');
            camera.quaternion.multiply(offset.setFromEuler(euler));
        },

        clear() {
            target.set(0, 0);
            current.set(0, 0);
        },
    };
}
