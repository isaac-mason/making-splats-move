import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FRACTION = 0.25;
const DURATION = 12;

export type CameraMove = {
    time: number;
    surrendered: boolean;
};

export function initCameraMove(domElement: HTMLElement): CameraMove {
    const move: CameraMove = { time: 0, surrendered: false };
    domElement.addEventListener('pointerdown', () => {
        move.surrendered = true;
    });
    domElement.addEventListener('wheel', () => {
        move.surrendered = true;
    });
    return move;
}

export function updateCameraMove(move: CameraMove, camera: THREE.PerspectiveCamera, controls: OrbitControls, dt: number): void {
    if (move.surrendered || move.time >= DURATION) return;
    const before = move.time;
    move.time = Math.min(DURATION, move.time + dt);
    const eased = (t: number) => 1 - (1 - t / DURATION) ** 3;
    const step = (eased(move.time) - eased(before)) * FRACTION;
    camera.position.lerp(controls.target, THREE.MathUtils.clamp(step, 0, 1));
}
