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
import { CAST } from './avatar-params';
import { type Crowd, initCrowd, knockDown, rebuildWalker, updateCrowd } from './crowd';
import type { DebugOverlay } from './debug';
import { attachGrabbing, type Grab, initGrab, updateGrab } from './grab';
import { initLeaves } from './leaves';
import type { Options } from './options';
import { addGroundPlane, initPhysicsWorld, stepPhysics } from './physics';
import { attachPicking } from './picking';
import {
    GROUND_Y,
    SPLAT_OFFSET,
    SPLAT_SCALE,
    SPLAT_URL,
    WALK_ACROSS,
    WALK_CENTER,
    WALK_HALF_ACROSS,
    WALK_HALF_DEEP,
} from './scene';
import { beginShowcase, endShowcase, initShowcase, type Showcase, updateShowcase } from './showcase';
import { initToolbar, setToolCursor, type Toolbar } from './toolbar';

/**
 * The finished thing: a crowd walking a captured town square, and the two tools you
 * can point at them.
 *
 * Customize and grab are two readings of the same pointer, so they're wired together
 * against the same crowd and the toolbar decides what a press means.
 */

/** One of each of the cast. */
const WALKERS = CAST.length;
/** Seed for the splat lattice jitter. Who's in the crowd is the cast, not this. */
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
    boundsBox: THREE.LineSegments;
    /** The falling leaves, when the capture is loaded. */
    leaves: THREE.Object3D | null;
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

    let leaves: THREE.Object3D | null = null;
    if (!options.bare) {
        const world = new SplatMesh({ url: SPLAT_URL, paged: true });
        world.scale.setScalar(SPLAT_SCALE);
        world.position.set(...SPLAT_OFFSET);
        scene.add(world);
        // Leaves off the trees — they belong to the capture, so go with it.
        leaves = initLeaves().object;
        scene.add(leaves);
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

    return { context, physics, crowd, grab, showcase, toolbar, editor, leaves, boundsBox: addBoundsBox(scene) };
}

export function updateTownSquare(square: TownSquare, dt: number): void {
    const { camera, controls, debug } = square.context;
    square.boundsBox.visible = debug.showBounds;
    if (square.leaves) square.leaves.visible = debug.leaves;
    square.crowd.moving = debug.movement;
    // Checked every frame rather than on the toggle, so a walker rebuilt by the
    // editor — which comes back skinned — follows the panel too.
    for (const w of square.crowd.walkers) {
        const skinning = debug.skinning ? w.avatar.skinning : null;
        if (w.avatar.mesh.skinning === skinning) continue;
        w.avatar.mesh.skinning = skinning;
        // Skinning is compiled into the mesh's generator, so swapping it rebuilds that.
        w.avatar.mesh.updateGenerator();
    }
    updateAvatarEditor(square.editor);
    if (!debug.frozen) {
        // Physics first, so a walker reads the step that just happened.
        updateGrab(square.grab, dt);
        stepPhysics(square.physics, dt);
        updateCrowd(square.crowd, square.physics, dt, camera.position);
    }
    // After the orbit controls, so the camera travel isn't fighting them.
    updateShowcase(square.showcase, camera, controls, dt);
}

export function townSquareSplats(square: TownSquare): number {
    return square.crowd.walkers.reduce((n, w) => n + w.avatar.mesh.numSplats, 0);
}

/** The box the crowd may wander inside, drawn on demand. */
function addBoundsBox(scene: THREE.Scene): THREE.LineSegments {
    // Turned like the walk area: its local x runs across the view.
    const height = 1.8;
    const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(WALK_HALF_ACROSS * 2, height, WALK_HALF_DEEP * 2)),
        new THREE.LineBasicMaterial({ color: 0x44ff88 }),
    );
    box.position.set(WALK_CENTER[0], GROUND_Y + height / 2, WALK_CENTER[2]);
    box.rotation.y = Math.atan2(-WALK_ACROSS[1], WALK_ACROSS[0]);
    box.visible = false;
    scene.add(box);
    return box;
}
