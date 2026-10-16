/**
 * A slow parallax lean toward a hovering mouse: enough that the clearing feels like
 * somewhere you're standing rather than a photograph with a fire painted on, small
 * enough you don't quite notice it. Mouse only — touch has no hover, and reacting
 * to it would fight the orbit gesture.
 *
 * OrbitControls derives its state FROM `camera.position` each update, so an offset
 * left in the position compounds into a drift. Hence `apply()`: back last frame's
 * lean out, let OrbitControls update a clean position, then lean again.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Maximum lean in world units, at the very edge of the window. */
const DRIFT_RANGE = 0.2;
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
     * A scripted pointer in place of the real one: window coordinates, -1..1 each
     * way. For recordings. `snap` puts the lean there at once, for a take's first frame.
     */
    drive(x: number, y: number, snap?: boolean): void;
};

export function createCameraDrift(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
): CameraDrift {
    const target = new THREE.Vector2();
    const current = new THREE.Vector2();
    /** The offset baked into camera.position, to back out next frame. */
    const applied = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const forward = new THREE.Vector3();

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

            camera.position.sub(applied);
            controls.update();

            // Along the camera's own axes, without re-aiming: that's what makes it
            // parallax rather than a pan.
            camera.matrixWorld.extractBasis(right, up, forward);
            applied
                .set(0, 0, 0)
                .addScaledVector(right, current.x * DRIFT_RANGE)
                .addScaledVector(up, current.y * DRIFT_RANGE);
            camera.position.add(applied);
        },

        clear() {
            target.set(0, 0);
            current.set(0, 0);
            applied.set(0, 0, 0);
        },

        drive(x, y, snap = false) {
            hovering = true;
            aim(x, y);
            if (snap) current.copy(target);
        },
    };
}
