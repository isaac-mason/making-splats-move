/**
 * The default scene: the cast walking a captured school courtyard, and the toolbar's
 * customize, grab and camera tools wired up against them.
 */

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
import {
    attachGrabbing,
    attachPicking,
    beginShowcase,
    endShowcase,
    type Grab,
    initGrab,
    initShowcase,
    initToolbar,
    type Showcase,
    setToolCursor,
    type Toolbar,
    updateGrab,
    updateShowcase,
} from './interaction';
import { initLeaves } from './leaves';
import type { Options } from './options';
import { addGroundPlane, initPhysicsWorld, stepPhysics } from './physics';
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

const WALKERS = CAST.length;
/** Only seeds the splat jitter: who's in the crowd is the cast. */
const CROWD_SEED = 7;

export type Courtyard = {
    context: CourtyardContext;
    physics: World;
    crowd: Crowd;
    grab: Grab;
    showcase: Showcase;
    toolbar: Toolbar;
    editor: AvatarEditor;
    boundsBox: THREE.LineSegments;
    /** Null under `?bare`, with no capture. */
    leaves: THREE.Object3D | null;
};

export type CourtyardContext = {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    domElement: HTMLElement;
    controls: OrbitControls;
    debug: DebugOverlay;
    options: Options;
};

export function initCourtyard(context: CourtyardContext): Courtyard {
    const { scene, camera, domElement, controls, debug, options } = context;

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
        // Its own tool: always-on, every grab also swung the camera.
        controls.enabled = tool === 'camera';
        setToolCursor(domElement, tool);
    });
    controls.enabled = false;

    // Customize: click a walker and they run to the front, with the editor bound to them.
    attachPicking(physics, camera, crowd, domElement, (pick) => {
        debug.selected = pick?.index ?? -1;
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

    // Grab: press and they go limp and come with you; let go and they fall.
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

export function updateCourtyard(courtyard: Courtyard, dt: number): void {
    const { camera, controls, debug } = courtyard.context;
    courtyard.boundsBox.visible = debug.showBounds;
    if (courtyard.leaves) courtyard.leaves.visible = debug.leaves;
    courtyard.crowd.moving = debug.movement;
    // Every frame, not on the toggle, so a walker the editor rebuilds follows it too.
    for (const w of courtyard.crowd.walkers) {
        const skinning = debug.skinning ? w.avatar.skinning : null;
        if (w.avatar.mesh.skinning === skinning) continue;
        w.avatar.mesh.skinning = skinning;
        w.avatar.mesh.updateGenerator();
    }
    updateAvatarEditor(courtyard.editor);
    if (!debug.frozen) {
        updateGrab(courtyard.grab, dt);
        stepPhysics(courtyard.physics, dt);
        updateCrowd(courtyard.crowd, courtyard.physics, dt, camera.position);
    }
    // After the orbit controls, so the camera travel isn't fighting them.
    updateShowcase(courtyard.showcase, camera, controls, dt);
}

export function courtyardSplats(courtyard: Courtyard): number {
    return courtyard.crowd.walkers.reduce((n, w) => n + w.avatar.mesh.numSplats, 0);
}

/** The box the crowd may wander inside, turned like the walk area. */
function addBoundsBox(scene: THREE.Scene): THREE.LineSegments {
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
