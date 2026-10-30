import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DRIFT_RANGE = 0.2;
const HALF_LIFE = 0.6;
const DEADZONE = 0.05;

export type CameraDrift = {
    apply(dt: number, lean?: boolean): void;
    clear(): void;
    drive(x: number, y: number, snap?: boolean): void;
};

export function createCameraDrift(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
): CameraDrift {
    const target = new THREE.Vector2();
    const current = new THREE.Vector2();
    const base = new THREE.Vector3();
    let hasBase = false;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const forward = new THREE.Vector3();

    let hovering = false;
    const mouse = (event: PointerEvent) => event.pointerType === 'mouse';

    const aim = (x: number, y: number) => {
        // Ramp up from the deadzone's edge, so there's no jump leaving centre.
        const length = Math.hypot(x, y);
        const scale = length <= DEADZONE ? 0 : (length - DEADZONE) / (1 - DEADZONE) / length;
        target.set(x * scale, y * scale);
    };

    domElement.addEventListener('pointermove', (event) => {
        if (!mouse(event)) return;
        hovering = event.buttons === 0;
        if (!hovering) return;
        const rect = domElement.getBoundingClientRect();
        aim(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
    });
    domElement.addEventListener('pointerdown', (event) => {
        if (mouse(event)) hovering = false;
    });
    domElement.addEventListener('pointerup', (event) => {
        if (mouse(event)) hovering = true;
    });
    domElement.addEventListener('pointerleave', (event) => {
        if (mouse(event)) hovering = false;
    });

    return {
        apply(dt, lean = true) {
            if (!hovering || !lean) target.set(0, 0);
            current.lerp(target, 1 - 0.5 ** (dt / HALF_LIFE));

            if (hasBase) camera.position.copy(base);
            controls.update();
            base.copy(camera.position);
            hasBase = true;

            camera.matrixWorld.extractBasis(right, up, forward);
            camera.position.addScaledVector(right, current.x * DRIFT_RANGE).addScaledVector(up, current.y * DRIFT_RANGE);
        },

        clear() {
            target.set(0, 0);
            current.set(0, 0);
            hasBase = false;
        },

        drive(x, y, snap = false) {
            hovering = true;
            aim(x, y);
            if (snap) current.copy(target);
        },
    };
}
