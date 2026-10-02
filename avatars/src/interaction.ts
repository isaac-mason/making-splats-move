/**
 * Everything you can do to the crowd with the pointer: the toolbar, picking a walker,
 * grabbing one and carrying it about, and the camera move that shows one off.
 */

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
import { quat, vec3 } from 'math';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { type Crowd, showWalker, unshowWalker, type Walker } from './crowd';
import { bodyPosition, LAYER_HAND, type Puppet, pickBody, puppetOwns } from './physics';
import { CAMERA_POSITION, CAMERA_TARGET, SHOWCASE_CAMERA, SHOWCASE_LOOK_Y } from './scene';

/* toolbar */

// Customize (click a walker to edit them), grab (drag one about) and camera (orbit)
// all want the same pointer, so the mode is explicit and always on screen.

export type Tool = 'customize' | 'grab' | 'camera';

export type Toolbar = {
    element: HTMLDivElement;
    tool: Tool;
};

const ICONS: Record<Tool, string> = {
    customize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" width="21" height="21">
        <line x1="4" y1="7" x2="20" y2="7"/><circle cx="10" cy="7" r="2.4" fill="currentColor" stroke="none"/>
        <line x1="4" y1="13" x2="20" y2="13"/><circle cx="16" cy="13" r="2.4" fill="currentColor" stroke="none"/>
        <line x1="4" y1="19" x2="20" y2="19"/><circle cx="8" cy="19" r="2.4" fill="currentColor" stroke="none"/>
    </svg>`,
    camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
        stroke-linecap="round" stroke-linejoin="round" width="21" height="21">
        <path d="M3 8.5a2 2 0 0 1 2-2h2.3l1.3-2h6.8l1.3 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <circle cx="12" cy="12.5" r="3.4"/>
    </svg>`,
    grab: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
        stroke-linecap="round" stroke-linejoin="round" width="21" height="21">
        <path d="M9 11V5.4a1.4 1.4 0 0 1 2.8 0V11"/>
        <path d="M11.8 10.6V4.3a1.4 1.4 0 0 1 2.8 0v6.3"/>
        <path d="M14.6 11V6.2a1.4 1.4 0 0 1 2.8 0V14a6 6 0 0 1-6 6h-.7a5 5 0 0 1-3.8-1.8l-3-3.6a1.4 1.4 0 0 1 2-1.9L9 14.4V11"/>
    </svg>`,
};

const TOOLS: Tool[] = ['customize', 'grab', 'camera'];

export function initToolbar(onChange?: (tool: Tool) => void): Toolbar {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:22px',
        'transform:translateX(-50%)',
        'display:flex',
        'gap:4px',
        'padding:5px',
        'border-radius:999px',
        'background:rgba(22,24,30,0.72)',
        'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)',
        'box-shadow:0 6px 24px rgba(0,0,0,0.28)',
        'font:12px/1 system-ui,sans-serif',
        'user-select:none',
        'z-index:1000',
    ].join(';');

    const toolbar: Toolbar = { element, tool: 'customize' };
    const buttons = new Map<Tool, HTMLButtonElement>();

    const paint = () => {
        for (const [tool, button] of buttons) {
            const on = tool === toolbar.tool;
            button.style.background = on ? '#f4f5f7' : 'transparent';
            button.style.color = on ? '#16181e' : 'rgba(255,255,255,0.72)';
        }
    };

    for (const tool of TOOLS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = tool;
        button.setAttribute('aria-label', tool);
        button.innerHTML = ICONS[tool];
        button.style.cssText = [
            'display:grid',
            'place-items:center',
            'width:42px',
            'height:38px',
            'border:0',
            'border-radius:999px',
            'cursor:pointer',
            'color:inherit',
            'transition:background 120ms,color 120ms,transform 120ms',
        ].join(';');
        button.addEventListener('pointerenter', () => {
            button.style.transform = 'translateY(-2px)';
        });
        button.addEventListener('pointerleave', () => {
            button.style.transform = '';
        });
        button.addEventListener('click', () => {
            if (toolbar.tool === tool) return;
            toolbar.tool = tool;
            paint();
            onChange?.(tool);
        });
        buttons.set(tool, button);
        element.append(button);
    }

    paint();
    document.body.append(element);
    return toolbar;
}

/** The cursor says which tool is live. */
export function setToolCursor(domElement: HTMLElement, tool: Tool, dragging = false): void {
    if (tool === 'grab') domElement.style.cursor = dragging ? 'grabbing' : 'grab';
    else if (tool === 'camera') domElement.style.cursor = 'move';
    else domElement.style.cursor = '';
}

/* picking */

// Against the physics capsules, not the splats: Spark raycasts the splats' REST pose
// (skinning happens in the shader), so to it everyone is always standing up. The
// capsules match the drawn pose.

/** Metres: past the far side of the courtyard. */
const PICK_RANGE = 60;

export type Pick = {
    walker: Walker;
    index: number;
    /** Where on them the ray landed, in world space. */
    point: THREE.Vector3;
};

const ndc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const point = new THREE.Vector3();

/** The ray under the pointer. Shared: valid until the next call. */
function pointerRay(camera: THREE.Camera, domElement: HTMLElement, event: { clientX: number; clientY: number }): THREE.Ray {
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
}

function pickWalker(
    world: World,
    camera: THREE.Camera,
    crowd: Crowd,
    domElement: HTMLElement,
    event: { clientX: number; clientY: number },
): Pick | null {
    const ray = pointerRay(camera, domElement, event);
    const body = pickBody(world, ray.origin, ray.direction, PICK_RANGE, point);
    if (!body) return null;
    const index = crowd.walkers.findIndex((w) => puppetOwns(w.puppet, body));
    if (index < 0) return null;
    return { walker: crowd.walkers[index], index, point: point.clone() };
}

/** Click a walker; null when the click hit nobody. */
export function attachPicking(
    world: World,
    camera: THREE.Camera,
    crowd: Crowd,
    domElement: HTMLElement,
    onPick: (pick: Pick | null) => void,
): void {
    domElement.addEventListener('click', (event) => {
        onPick(pickWalker(world, camera, crowd, domElement, event));
    });
}

/* grab */

// A kinematic "hand" follows the pointer, tied to the nearest limb by a zero-length
// distance constraint: a grip, not a weld, so the body swings under it. The drag runs
// through a camera-facing plane, so you can lift someone, not just slide them.

export type Grab = {
    hand: RigidBody;
    /** Live while something is held. */
    constraint: DistanceConstraint | null;
    /** Where the hand is heading. */
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

/** Take hold of the limb nearest `point`. */
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
    const at = vec3.fromValues(point.x, point.y, point.z);
    rigidBody.setPosition(world, grab.hand, at, true);
    grab.constraint = distanceConstraint.create(world, {
        bodyIdA: grab.hand.id,
        bodyIdB: held.id,
        pointA: vec3.clone(at),
        pointB: vec3.clone(at),
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

const _handAt = vec3.create();
const UPRIGHT = quat.create();

export function updateGrab(grab: Grab, dt: number): void {
    if (!grab.constraint) return;
    const { x, y, z } = grab.target;
    rigidBody.moveKinematic(grab.hand, vec3.set(_handAt, x, y, z), UPRIGHT, Math.max(dt, 1 / 120));
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
    /** Switched off for the length of a drag. */
    controls: { enabled: boolean };
    /** Whether the grab tool is selected. */
    isEnabled: () => boolean;
    onDragChange?: (dragging: boolean) => void;
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

/* showcase */

// The camera drops to the chosen walker and rises again after — a move, not a cut,
// so you can follow them in. Runs AFTER `controls.update()` and writes the orbit
// target too, so the controls don't drag it back next frame.

export type Showcase = {
    walker: Walker | null;
    /** 0 = the scene camera, 1 = the portrait. */
    t: number;
    /** Which way `t` is heading. */
    closing: boolean;
    /** Damped toward the walker, so switching subjects mid-showcase doesn't jump. */
    look: THREE.Vector3;
};

/** Seconds each way. */
const TRAVEL = 0.85;
const AIM_TAU = 0.42;
/** m/s. Damping alone whips on a long switch; this is well above a runner's pace. */
const AIM_MAX_SPEED = 6;

const scenePos = new THREE.Vector3(...CAMERA_POSITION);
const sceneTarget = new THREE.Vector3(...CAMERA_TARGET);
const portraitPos = new THREE.Vector3(...SHOWCASE_CAMERA);
const chest = new THREE.Vector3();
const step = new THREE.Vector3();

export function initShowcase(): Showcase {
    return { walker: null, t: 0, closing: false, look: new THREE.Vector3(...CAMERA_TARGET) };
}

function aimAt(out: THREE.Vector3, walker: Walker): THREE.Vector3 {
    return out.copy(walker.position).setY(walker.position.y + SHOWCASE_LOOK_Y);
}

export function beginShowcase(showcase: Showcase, walker: Walker): void {
    if (showcase.walker && showcase.walker !== walker) unshowWalker(showcase.walker);
    // At t = 0 the aim isn't visible yet, so it can snap.
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
    // Home and idle: hands off the camera.
    if (showcase.t === target && target === 0) return;
    showcase.t = THREE.MathUtils.clamp(showcase.t + (target === 1 ? dt / TRAVEL : -dt / TRAVEL), 0, 1);

    const walker = showcase.walker;
    if (walker) {
        step.copy(aimAt(chest, walker))
            .sub(showcase.look)
            .multiplyScalar(1 - Math.exp(-dt / AIM_TAU));
        showcase.look.add(step.clampLength(0, AIM_MAX_SPEED * dt));
    }

    const k = THREE.MathUtils.smoothstep(showcase.t, 0, 1);
    camera.position.lerpVectors(scenePos, portraitPos, k);
    controls.target.lerpVectors(sceneTarget, showcase.look, k);
    camera.lookAt(controls.target);
}
