import {
    ConstraintSpace,
    type DistanceConstraint,
    distanceConstraint,
    MotionType,
    type RigidBody,
    rigidBody,
    sphere,
    type World,
} from 'crashcat';
import { quat, vec3 } from 'mathcat';
import * as THREE from 'three';
import type { Crowd, Walker } from './crowd';
import { bodyPosition, LAYER_HAND, type Puppet } from './physics';
import { pickWalker, pointerRay } from './picking';

/**
 * Picking someone up — both halves, because they're one feature.
 *
 * A kinematic "hand" body follows the pointer, tied to the nearest limb by a distance
 * constraint pinned at zero. A grip, not a weld: the body still swings under it,
 * which is the difference between carrying a person and steering a statue.
 *
 * Dropping and taking hold are one gesture, so they're one pointerdown. The drag
 * runs through a camera-facing plane, which is what lets you lift someone rather
 * than only slide them about.
 */

export type Grab = {
    hand: RigidBody;
    /** Live while something is held. */
    constraint: DistanceConstraint | null;
    /** Where the hand is being asked to go, in world space. */
    target: THREE.Vector3;
};

export function initGrab(world: World): Grab {
    const hand = rigidBody.create(world, {
        shape: sphere.create({ radius: 0.02, density: 1000 }),
        objectLayer: LAYER_HAND,
        motionType: MotionType.KINEMATIC,
        position: vec3.fromValues(0, -100, 0),
    });
    return { hand, constraint: null, target: new THREE.Vector3() };
}

const toBody = new THREE.Vector3();

/** Nearest body to the grabbed point — the pick already happened; this picks a limb. */
function grabPuppet(world: World, grab: Grab, puppet: Puppet, point: THREE.Vector3): void {
    releaseGrab(world, grab);

    let held = puppet.bodies[0];
    let bestSq = Number.POSITIVE_INFINITY;
    for (const body of puppet.bodies) {
        bodyPosition(toBody, body).sub(point);
        const distSq = toBody.lengthSq();
        if (distSq < bestSq) {
            bestSq = distSq;
            held = body;
        }
    }

    grab.target.copy(point);
    rigidBody.setPosition(world, grab.hand, vec3.fromValues(point.x, point.y, point.z), true);
    grab.constraint = distanceConstraint.create(world, {
        bodyIdA: grab.hand.id,
        bodyIdB: held.id,
        pointA: vec3.fromValues(point.x, point.y, point.z),
        pointB: vec3.fromValues(point.x, point.y, point.z),
        minDistance: 0,
        maxDistance: 0,
        space: ConstraintSpace.WORLD,
    });
}

function releaseGrab(world: World, grab: Grab): void {
    if (!grab.constraint) return;
    distanceConstraint.remove(world, grab.constraint);
    grab.constraint = null;
}

/** Drive the hand toward its target. Kinematic, so it moves whatever it's holding. */
export function updateGrab(grab: Grab, dt: number): void {
    if (!grab.constraint) return;
    rigidBody.moveKinematic(
        grab.hand,
        vec3.fromValues(grab.target.x, grab.target.y, grab.target.z),
        quat.fromValues(0, 0, 0, 1),
        Math.max(dt, 1 / 120),
    );
}

const dragPlane = new THREE.Plane();
const planeNormal = new THREE.Vector3();
const hitPoint = new THREE.Vector3();

export type GrabOptions = {
    world: World;
    grab: Grab;
    camera: THREE.PerspectiveCamera;
    crowd: Crowd;
    domElement: HTMLElement;
    /** Orbit controls, switched off for the duration of a drag and put back as they were. */
    controls: { enabled: boolean };
    /** Whether grabbing is armed at all — i.e. whether the grab tool is selected. */
    isEnabled: () => boolean;
    /** Told when a drag starts and ends, so the cursor can say which. */
    onDragChange?: (dragging: boolean) => void;
    /** Knock this walker down, if it isn't already. */
    knockDown: (walker: Walker) => void;
};

export function attachGrabbing(options: GrabOptions): void {
    const { world, grab, camera, crowd, domElement, controls, isEnabled, knockDown, onDragChange } = options;
    let held = false;
    let grabbed: Walker | null = null;
    let controlsWere = false;

    domElement.addEventListener('pointerdown', (event) => {
        if (!isEnabled() || event.button !== 0) return;
        const pick = pickWalker(world, camera, crowd, domElement, event);
        if (!pick) return;

        knockDown(pick.walker);
        pick.walker.held = true;
        grabbed = pick.walker;
        grabPuppet(world, grab, pick.walker.puppet, pick.point);
        // Screen-space dragging: what's under the cursor is where the hand goes.
        camera.getWorldDirection(planeNormal);
        dragPlane.setFromNormalAndCoplanarPoint(planeNormal, pick.point);

        held = true;
        onDragChange?.(true);
        controlsWere = controls.enabled;
        controls.enabled = false;
        domElement.setPointerCapture(event.pointerId);
    });

    domElement.addEventListener('pointermove', (event) => {
        if (!held) return;
        if (pointerRay(camera, domElement, event).intersectPlane(dragPlane, hitPoint)) grab.target.copy(hitPoint);
    });

    const drop = (event: PointerEvent) => {
        if (!held) return;
        held = false;
        onDragChange?.(false);
        if (grabbed) grabbed.held = false;
        grabbed = null;
        releaseGrab(world, grab);
        controls.enabled = controlsWere;
        if (domElement.hasPointerCapture(event.pointerId)) domElement.releasePointerCapture(event.pointerId);
    };
    domElement.addEventListener('pointerup', drop);
    domElement.addEventListener('pointercancel', drop);
}
