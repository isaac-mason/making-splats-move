import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * A slow parallax nudge: while the mouse is just hovering, the camera leans a
 * little toward the cursor. Enough to make the clearing feel like somewhere you
 * are standing rather than a photograph you are looking at, and small enough that
 * you don't quite notice it happening.
 *
 * It earns its keep more here than anywhere: the scene is a static capture, so
 * without it the only things that ever move are the fire's own particles, and a
 * still frame with a fire painted on it is exactly what this is trying not to
 * look like.
 *
 * Mouse only, deliberately. On a touch screen there's no hover — a finger is
 * either dragging or absent — so there's nothing sensible to track, and reacting
 * to touch would just fight the orbit gesture. Every listener here ignores any
 * pointer that isn't a mouse, so phones get the plain orbit camera.
 *
 * The fiddly part is co-existing with OrbitControls. Its `update()` derives its
 * spherical state *from* `camera.position` each frame, so an offset added on top
 * gets absorbed into that state and compounds into a slow unwanted drift. Hence
 * `apply()`: back the previous offset out, let OrbitControls do its thing on a
 * clean position, then add the new one. OrbitControls only ever sees the camera
 * where it put it.
 */

/** Maximum lean, in world units, at the very edge of the window. */
const DRIFT_RANGE = 0.2;
/** Seconds to cover most of the distance to a new cursor position. */
const SMOOTHING = 0.6;
/** How far the cursor has to be from centre before anything moves, 0..1. */
const DEADZONE = 0.05;

export type CameraDrift = {
    /**
     * Call once per frame, in place of `controls.update()`. Pass `lean: false` to
     * hand the camera over to something else (the debug orbit camera): the lean
     * eases back to centre rather than cutting, and `controls.update()` still runs.
     */
    apply(dt: number, lean?: boolean): void;
    /**
     * Forget the current lean WITHOUT moving the camera. Only for a caller that is
     * about to set `camera.position` itself — otherwise the offset this was holding
     * stays silently baked into the position it never got to subtract.
     */
    clear(): void;
};

export function createCameraDrift(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
): CameraDrift {
    // Where the cursor wants the camera, and where it actually is.
    const target = new THREE.Vector2();
    const current = new THREE.Vector2();
    // The offset currently baked into camera.position, so it can be backed out.
    const applied = new THREE.Vector3();

    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const next = new THREE.Vector3();

    let hovering = false;

    const isMouse = (event: PointerEvent) => event.pointerType === 'mouse';

    domElement.addEventListener('pointermove', (event) => {
        if (!isMouse(event)) return;
        // Any button held means an orbit drag is in progress — that gesture owns
        // the camera, so stop leaning and let it settle back to centre.
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
    // Cursor gone — recentre rather than holding the last lean.
    domElement.addEventListener('pointerleave', (event) => {
        if (isMouse(event)) hovering = false;
    });

    return {
        apply(dt, lean = true) {
            if (!hovering || !lean) target.set(0, 0);

            // Frame-rate independent approach: the same fraction of the remaining
            // distance per second, whatever the frame rate.
            const t = 1 - 0.5 ** (dt / SMOOTHING);
            current.lerp(target, t);

            // Undo last frame's lean, so OrbitControls reads the position it set.
            camera.position.sub(applied);
            controls.update();

            // Lean along the camera's own axes, so it reads the same from any
            // orbit angle. Orientation is left alone: shifting the eye without
            // re-aiming is what makes it parallax rather than a pan.
            camera.matrixWorld.extractBasis(right, up, next);
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
    };
}
