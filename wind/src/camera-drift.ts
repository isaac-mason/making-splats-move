import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * A slow look-around: while the mouse is just hovering, the camera tilts a little
 * toward the cursor. Enough to make the city feel like somewhere you are standing
 * rather than a photograph you are looking at, and small enough that you don't
 * quite notice it happening.
 *
 * TILT, not translate — and the two are genuinely different effects, not two
 * spellings of the same one:
 *
 *   - Shifting the eye without re-aiming it is PARALLAX. Near things slide against
 *     far things, which is the cue that sells depth. It needs near things to slide.
 *   - Rotating in place is a PAN. Everything moves together and no depth is
 *     revealed at all — but it costs nothing to see, because what you perceive is
 *     the angle swept.
 *
 * Which one wins is a property of the scene. Over a firepit a few units away, a
 * half-unit shift is a large fraction of the distance to the subject and the logs
 * visibly slide against the treeline. Out here the nearest thing is eleven units
 * off and the rest of the city is far behind it, so the same shift buys almost no
 * relative motion — you'd be moving the camera and getting nothing for it. A
 * couple of degrees of pan, on the other hand, moves the whole frame by a few
 * percent of its height, which reads immediately.
 *
 * Mouse only, deliberately. On a touch screen there's no hover — a finger is
 * either dragging or absent — so there's nothing sensible to track, and reacting
 * to touch would just fight the orbit gesture. Every listener here ignores any
 * pointer that isn't a mouse, so phones get the plain camera.
 *
 * Co-existing with OrbitControls is much easier this way round. Its `update()`
 * recomputes the camera's orientation from `position` and `target` every frame, so
 * a rotation applied afterwards is simply overwritten next frame rather than
 * absorbed — it cannot compound, and nothing has to be backed out. (A position
 * offset does have to be: OrbitControls derives its spherical state *from*
 * `camera.position`, so an offset added on top becomes part of that state and
 * creeps. The `fire/` copy of this file has to deal with exactly that.)
 */

/** Maximum tilt, in radians, at the very edge of the window. */
const TILT_RANGE = THREE.MathUtils.degToRad(2.5);
/** Seconds to cover most of the distance to a new cursor position. */
const SMOOTHING = 0.6;
/** How far the cursor has to be from centre before anything moves, 0..1. */
const DEADZONE = 0.05;

export type CameraDrift = {
    /**
     * Call once per frame, in place of `controls.update()`. Pass `lean: false` to
     * hand the camera over to something else (the debug orbit camera): the tilt
     * eases back to centre rather than cutting, and `controls.update()` still runs.
     */
    apply(dt: number, lean?: boolean): void;
    /** Forget the current tilt, so nothing eases back from a stale value. */
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

    const euler = new THREE.Euler();
    const offset = new THREE.Quaternion();

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
    // Cursor gone — recentre rather than holding the last tilt.
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

            controls.update();

            // Applied AFTER update(), and multiplied on the right so it's a rotation
            // in the camera's own frame — pitch up toward a cursor above centre, yaw
            // right toward one to the right. YXZ is the usual look-around order; at
            // a couple of degrees it barely matters which.
            euler.set(current.y * TILT_RANGE, -current.x * TILT_RANGE, 0, 'YXZ');
            camera.quaternion.multiply(offset.setFromEuler(euler));
        },

        clear() {
            target.set(0, 0);
            current.set(0, 0);
        },
    };
}
