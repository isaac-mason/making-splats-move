import { SplatMesh } from '@sparkjsdev/spark';
import type { World } from 'crashcat';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initAvatar } from './avatar';
import {
    type AvatarEditor,
    createAvatarEditor,
    setAvatarEditorVisible,
    syncAvatarEditor,
    updateAvatarEditor,
} from './avatar-editor';
import { type Crowd, initCrowd, knockDown, rebuildWalker, updateCrowd } from './crowd';
import type { DebugOverlay } from './debug';
import { attachGrabbing, type Grab, initGrab, updateGrab } from './grab';
import type { Options } from './options';
import { addGroundPlane, initPhysicsWorld, stepPhysics } from './physics';
import { attachPicking } from './picking';
import { GROUND_Y, SPLAT_OFFSET, SPLAT_SCALE, SPLAT_URL, WALK_BOUNDS_X, WALK_BOUNDS_Z, WALK_CENTER } from './scene';
import { beginShowcase, endShowcase, initShowcase, type Showcase, updateShowcase } from './showcase';
import { initToolbar, setToolCursor, type Toolbar } from './toolbar';

/**
 * The finished thing: a crowd walking a captured town square, and the two tools you
 * can point at them.
 *
 * Customize and grab are two readings of the same pointer, so they're wired together
 * against the same crowd and the toolbar decides what a press means.
 */

/** How many walkers the square gets. */
const WALKERS = 5;
/** Seed for the crowd. Change it and all five are re-rolled. */
const CROWD_SEED = 7;

export type TownSquare = {
    /** Held rather than passed back in, so a frame needs no arguments. */
    context: TownSquareContext;
    physics: World;
    crowd: Crowd;
    grab: Grab;
    showcase: Showcase;
    toolbar: Toolbar;
    editor: AvatarEditor;
    boundsBox: THREE.Box3Helper;
};

export type TownSquareContext = {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    domElement: HTMLElement;
    controls: OrbitControls;
    debug: DebugOverlay;
    options: Options;
};

export function initTownSquare(context: TownSquareContext): TownSquare {
    const { scene, camera, domElement, controls, debug, options } = context;

    // Physics is what makes the walkers solid to each other and what catches them
    // when they're knocked over, so it comes before the crowd that needs it.
    if (options.bounds) debug.showBounds = true;

    const physics = initPhysicsWorld();
    addGroundPlane(physics, GROUND_Y);
    const grab = initGrab(physics);
    const crowd = initCrowd(physics, WALKERS, CROWD_SEED);
    for (const walker of crowd.walkers) scene.add(walker.avatar.mesh);

    if (!options.bare) {
        const world = new SplatMesh({ url: SPLAT_URL });
        world.scale.setScalar(SPLAT_SCALE);
        world.position.set(...SPLAT_OFFSET);
        scene.add(world);
    }

    const showcase = initShowcase();
    const editor = createAvatarEditor(
        () => {},
        () => endShowcase(showcase),
    );

    const toolbar = initToolbar((tool) => {
        if (tool !== 'customize') {
            setAvatarEditorVisible(editor, false);
            endShowcase(showcase);
        }
        // Its own tool: left always-on, every attempt to grab someone also swung it.
        controls.enabled = tool === 'camera';
        setToolCursor(domElement, tool);
    });
    controls.enabled = false;

    // CUSTOMIZE: click a walker, they run out to the front, sliders bound to THAT one.
    attachPicking(physics, camera, crowd, domElement, (pick) => {
        debug.selected = pick?.index ?? -1;
        // Under the grab tool a press means "pick them up" — handled below.
        if (toolbar.tool !== 'customize') return;
        const walker = pick?.walker;
        if (!walker) {
            setAvatarEditorVisible(editor, false);
            endShowcase(showcase);
            return;
        }
        beginShowcase(showcase, walker);
        Object.assign(editor.params, walker.avatar.params);
        syncAvatarEditor(editor);
        editor.rebuild = (next) => {
            scene.remove(walker.avatar.mesh);
            rebuildWalker(physics, walker, crowd.walkers.indexOf(walker), initAvatar({ ...next }, 1));
            scene.add(walker.avatar.mesh);
        };
        setAvatarEditorVisible(editor, true);
    });

    // GRAB: press and they drop and come with you; let go and they fall.
    attachGrabbing({
        world: physics,
        grab,
        camera,
        crowd,
        domElement,
        controls,
        isEnabled: () => toolbar.tool === 'grab',
        knockDown: (walker) => knockDown(physics, walker),
        onDragChange: (dragging) => setToolCursor(domElement, 'grab', dragging),
    });

    return { context, physics, crowd, grab, showcase, toolbar, editor, boundsBox: addBoundsBox(scene) };
}

export function updateTownSquare(square: TownSquare, dt: number): void {
    const { camera, controls, debug } = square.context;
    square.boundsBox.visible = debug.showBounds;
    updateAvatarEditor(square.editor);
    if (!debug.frozen) {
        // Physics first, so a walker reads the step that just happened.
        updateGrab(square.grab, dt);
        stepPhysics(square.physics, dt);
        updateCrowd(square.crowd, square.physics, dt);
    }
    // After the orbit controls, so the camera travel isn't fighting them.
    updateShowcase(square.showcase, camera, controls, dt);
}

export function townSquareSplats(square: TownSquare): number {
    return square.crowd.walkers.reduce((n, w) => n + w.avatar.mesh.numSplats, 0);
}

/** The box the crowd may wander inside, drawn on demand. */
function addBoundsBox(scene: THREE.Scene): THREE.Box3Helper {
    const box = new THREE.Box3Helper(
        new THREE.Box3(
            new THREE.Vector3(WALK_CENTER[0] - WALK_BOUNDS_X, GROUND_Y, WALK_CENTER[2] - WALK_BOUNDS_Z),
            new THREE.Vector3(WALK_CENTER[0] + WALK_BOUNDS_X, GROUND_Y + 1.8, WALK_CENTER[2] + WALK_BOUNDS_Z),
        ),
        0x44ff88,
    );
    box.visible = false;
    scene.add(box);
    return box;
}
