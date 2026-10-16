/**
 * A slow lean toward a hovering mouse: enough that the clearing feels like
 * somewhere you're standing rather than a photograph with a fire painted on, small
 * enough you don't quite notice it. Mouse only — touch has no hover, and reacting
 * to it would fight the orbit gesture.
 *
 * Two styles. `orbit` swings the camera a degree or two about the shot's target,
 * so the fire holds its place while the near ground and the far trees slide past
 * each other. `parallax` slides the camera along its own axes without re-aiming.
 *
 * OrbitControls derives its state FROM `camera.position` each update, so a lean
 * left in the position compounds into a drift. Hence `apply()`: put back last
 * frame's clean position, let OrbitControls update it, then lean again.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type LeanStyle = 'orbit' | 'parallax';

/** Maximum parallax slide in world units, at the very edge of the window. */
const DRIFT_RANGE = 0.2;
/** Maximum orbit swing in radians, at the very edge of the window. */
const ORBIT_RANGE = 0.03;
/** Seconds to cover half the remaining distance to the cursor. */
const HALF_LIFE = 0.6;
/** How far from centre the cursor must be before anything moves, 0..1. */
const DEADZONE = 0.05;

export type CameraDrift = {
    /**
     * Call each frame in place of `controls.update()`. `lean: false` eases back to
     * centre, to hand the camera to something else.
     */
    apply(dt: number, lean?: boolean): void;
    /** Forget the lean WITHOUT moving the camera — only for a caller about to set the position itself. */
    clear(): void;
    /**
     * A scripted pointer in place of the real one: window coordinates, 1 at the
     * window's edge, past it allowed. For recordings. `snap` puts the lean there at
     * once, for a take's first frame.
     */
    drive(x: number, y: number, snap?: boolean): void;
};

export function createCameraDrift(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
    style: LeanStyle = 'orbit',
): CameraDrift {
    const target = new THREE.Vector2();
    const current = new THREE.Vector2();
    /** The clean position, before the lean, to restore next frame. */
    const base = new THREE.Vector3();
    let hasBase = false;
    const offset = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const swing = new THREE.Quaternion();
    const tilt = new THREE.Quaternion();

    let hovering = false;
    const mouse = (event: PointerEvent) => event.pointerType === 'mouse';

    /** Where the pointer is, in window coordinates, to where the lean is heading. */
    const aim = (x: number, y: number) => {
        // Ramp up from the deadzone's edge, so there's no jump leaving centre.
        const length = Math.hypot(x, y);
        const scale = length <= DEADZONE ? 0 : (length - DEADZONE) / (1 - DEADZONE) / length;
        target.set(x * scale, y * scale);
    };

    domElement.addEventListener('pointermove', (event) => {
        if (!mouse(event)) return;
        // A held button is an orbit drag, and that owns the camera.
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
            if (style === 'parallax') {
                // Along the camera's own axes, without re-aiming: that's what makes it
                // parallax rather than a pan.
                camera.position.addScaledVector(right, current.x * DRIFT_RANGE).addScaledVector(up, current.y * DRIFT_RANGE);
            } else {
                // Round the target: yaw about the world's up, pitch about the camera's
                // right, then look back at it.
                swing.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -current.x * ORBIT_RANGE);
                tilt.setFromAxisAngle(right, current.y * ORBIT_RANGE);
                offset.copy(camera.position).sub(controls.target).applyQuaternion(tilt).applyQuaternion(swing);
                camera.position.copy(controls.target).add(offset);
                camera.lookAt(controls.target);
            }
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
