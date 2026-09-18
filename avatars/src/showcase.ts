import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { showWalker, unshowWalker, type Walker } from './crowd';
import { smoothstep } from './ease';
import { CAMERA_POSITION, CAMERA_TARGET, SHOWCASE_CAMERA, SHOWCASE_LOOK_Y } from './scene';

/**
 * The camera half of showing someone off: it drops to the chosen walker and rises
 * again when you're done.
 *
 * It travels rather than cuts so you can follow the one you picked all the way in.
 *
 * Runs AFTER `controls.update()`, and writes both the camera and the orbit target, so
 * the controls round-trip it unchanged next frame instead of dragging it back.
 */

export type Showcase = {
    walker: Walker | null;
    /** 0 = the scene camera, 1 = the portrait. */
    t: number;
    /** Which way `t` is heading. */
    closing: boolean;
    /**
     * Where the camera is looking. Damped, not pinned to the walker: switching
     * subjects mid-showcase would otherwise jump the aim across the square in one
     * frame, since `t` is already 1 and nothing else is easing.
     */
    look: THREE.Vector3;
};

/** Seconds for the camera to travel, each way. */
const TRAVEL = 0.85;
const AIM_TAU = 0.42;
/**
 * Metres per second, capping the damping.
 *
 * Damping alone is continuous but not calm — its rate is proportional to the distance
 * left, so a switch across the square starts at ~17 m/s and whips. Well above walking
 * pace, so following one runner in is unaffected.
 */
const AIM_MAX_SPEED = 6;

const scenePos = new THREE.Vector3(...CAMERA_POSITION);
const sceneTarget = new THREE.Vector3(...CAMERA_TARGET);
const portraitPos = new THREE.Vector3(...SHOWCASE_CAMERA);
const chest = new THREE.Vector3();
const step = new THREE.Vector3();

export function initShowcase(): Showcase {
    return { walker: null, t: 0, closing: false, look: new THREE.Vector3(...CAMERA_TARGET) };
}

/** Where the camera wants to be looking for a given walker. */
function aimAt(out: THREE.Vector3, walker: Walker): THREE.Vector3 {
    return out.copy(walker.position).setY(walker.position.y + SHOWCASE_LOOK_Y);
}

export function beginShowcase(showcase: Showcase, walker: Walker): void {
    if (showcase.walker && showcase.walker !== walker) unshowWalker(showcase.walker);
    // From a standing start the aim is hidden behind t = 0, so snapping it is free.
    if (showcase.t === 0) aimAt(showcase.look, walker);
    showcase.walker = walker;
    showcase.closing = false;
    showWalker(walker);
}

export function endShowcase(showcase: Showcase): void {
    if (showcase.walker) unshowWalker(showcase.walker);
    showcase.walker = null;
    showcase.closing = true;
}

export function updateShowcase(showcase: Showcase, camera: THREE.Camera, controls: OrbitControls, dt: number): void {
    const target = showcase.closing || !showcase.walker ? 0 : 1;
    // Fully home and idle: hands off, so the camera tool starts from a clean slate.
    if (showcase.t === target && target === 0) return;
    showcase.t = THREE.MathUtils.clamp(showcase.t + (target === 1 ? dt / TRAVEL : -dt / TRAVEL), 0, 1);

    // The walker, not the fixed spot, so the camera follows them while they run in.
    const walker = showcase.walker;
    if (walker) {
        step.copy(aimAt(chest, walker))
            .sub(showcase.look)
            .multiplyScalar(1 - Math.exp(-dt / AIM_TAU));
        showcase.look.add(step.clampLength(0, AIM_MAX_SPEED * dt));
    }

    const k = smoothstep(showcase.t);
    camera.position.lerpVectors(scenePos, portraitPos, k);
    controls.target.lerpVectors(sceneTarget, showcase.look, k);
    camera.lookAt(controls.target);
}
