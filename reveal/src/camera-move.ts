import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * A slow push toward the target while the city assembles.
 *
 * Only because a reveal watched from a locked-off camera reads as a video rather
 * than a scene. It gives way the moment the pointer goes down: the drift is a
 * default, not a rail, and fighting someone's own drag is worse than not moving.
 */

/** How far toward the look point the drift travels, as a FRACTION — so moving the
 *  camera can't turn a nudge into a lunge, or send it out the far side. */
const FRACTION = 0.25;
/** Seconds it takes to travel it. */
const DURATION = 12;

export type CameraMove = {
    time: number;
    /** Set once the viewer takes over. */
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
    // Ease out, so it arrives rather than stopping.
    const eased = (t: number) => 1 - (1 - t / DURATION) ** 3;
    const step = (eased(move.time) - eased(before)) * FRACTION;
    camera.position.lerp(controls.target, THREE.MathUtils.clamp(step, 0, 1));
}
