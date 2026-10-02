import { SparkRenderer } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createDebugOverlay, updateDebugOverlay } from './debug';
import { type Options, readOptions } from './options';
import { CAMERA_POSITION, CAMERA_TARGET } from './scene';
import { initTownSquare, type TownSquare, townSquareSplats, updateTownSquare } from './town-square';
import { applyTreeSway, createSwayUniforms, type SwayUniforms, setTreeSwayEnabled, tickTreeSway } from './tree-sway';
import { initWorkbench, updateWorkbench, type Workbench, workbenchSplats } from './workbench';
import './style.css';

// Procedural rigged characters, generated and skinned on the GPU — no scan, no
// mesh, no asset.
//
// This began as a spike on one question: does Spark's SplatSkinning actually work?
// Worth asking, because there is no working example of it anywhere — not in Spark's
// repo (its only real usage targets an unreleased bone-weight API that ships in
// neither 2.1.0 nor 2.2.0), not in its docs or examples gallery, and not outside
// it, and it's marked experimental in its own header. It does work.
//
// What's left is two worlds that share the avatar and nothing else. `town-square.ts`
// is the finished one: five of them walking a captured square, with tools to
// customize and to knock over. `workbench.ts` is where it came from — one rig on a
// plain stage, behind `?limb`, `?figure`, `?editor` and `?crowd=N`. Those are kept
// because they fail far more legibly than a finished character does.

type State = {
    options: Options;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    spark: SparkRenderer;
    sway: SwayUniforms;
    controls: OrbitControls;
    debug: ReturnType<typeof createDebugOverlay>;
    square: TownSquare | null;
    bench: Workbench | null;
};

function init(): State {
    const options = readOptions();
    const scene = new THREE.Scene();
    // `?bg=ff00ff` is the quickest way to tell "no splats here" from "dark splats
    // here": anywhere the loud colour shows through is a gap, anywhere still dark is
    // geometry. Sky blue by default in the square, so a hole in the capture's sky
    // reads as sky rather than as a void.
    scene.background = new THREE.Color(options.background ?? (options.townSquare ? 0x8ec8ea : 0x10131a));

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    // The trees' wind is drawn in Spark's splat shader, so its uniforms have to be
    // handed over at construction. Harmless in the workbench: there are no trees there.
    const sway = createSwayUniforms(undefined, options.sway);
    const spark = new SparkRenderer({ renderer, extraUniforms: sway });
    applyTreeSway(spark);
    scene.add(spark);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    frameCamera(camera, controls, options);

    // The debug panel the other examples have: backtick to toggle, click-to-copy
    // coordinates, and a readout of what the pointer last hit.
    const debug = createDebugOverlay();

    // Exactly one of these is built. The workbench flags and the square are mutually
    // exclusive by construction — see `Options.workbench`.
    const bench = options.workbench ? initWorkbench(scene, camera, options) : null;
    const square = options.workbench
        ? null
        : initTownSquare({ scene, camera, domElement: renderer.domElement, controls, debug, options });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { options, scene, camera, renderer, spark, sway, controls, debug, square, bench };
}

/**
 * Point the camera at whatever's being shown.
 *
 * `?cam=x,y,z&look=x,y,z` wins over everything. The capture has holes in it — the
 * near foreground where the photographer stood, and parts of the sky — so finding an
 * angle that avoids them is a search, and doing that by editing scene.ts and
 * reloading is slower than it needs to be.
 *
 * The named views exist because judging a solid from one front view is how you miss
 * a head buried in a chest: front-on, an intersection and a clean join look
 * identical. The side view is the one that tells the truth.
 */
function frameCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, options: Options): void {
    const dist = options.face ? 1.55 : 2.8;
    const eyeY = options.face ? 1.34 : 1.15;

    if (options.cam) camera.position.copy(options.cam);
    else if (options.townSquare) camera.position.set(...CAMERA_POSITION);
    else if (options.view === 'front') camera.position.set(0, eyeY, dist);
    else if (options.view === 'side') camera.position.set(dist, eyeY, 0);
    else if (options.view === 'top') camera.position.set(0, eyeY + dist, 0.01);
    // Head and shoulders, framed to match reference/avatar-target.png so the two can
    // be put side by side and actually compared.
    else if (options.view === 'bust') camera.position.set(0, 1.4, 1.2);
    else camera.position.set(dist * 0.55, eyeY, dist * 0.84);

    if (options.look) controls.target.copy(options.look);
    else if (options.townSquare) controls.target.set(...CAMERA_TARGET);
    else controls.target.set(0, options.limb ? 1.0 : options.view === 'bust' ? 1.4 : options.face ? 1.32 : 0.88, 0);
    controls.update();
}

function update(state: State, time: number, dt: number): void {
    if (state.square) updateTownSquare(state.square, dt);
    // `?t=1.25` freezes the pose. A moving rig is a terrible thing to test against —
    // you can never tell whether a still frame caught a bug or just caught the
    // bottom of the swing.
    if (state.bench) updateWorkbench(state.bench, state.options, state.options.frozenTime ?? time, time);

    state.controls.update();
    setTreeSwayEnabled(state.sway, state.debug.sway);
    tickTreeSway(state.spark, state.sway, time);
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.spark, state.square?.crowd ?? null);
    state.renderer.render(state.scene, state.camera);
}

const state = init();
console.log(
    `avatars: ${((state.square ? townSquareSplats(state.square) : 0) + (state.bench ? workbenchSplats(state.bench) : 0)).toLocaleString()} splats`,
);

let frames = 0;
let statsStart = performance.now();
let lastTime = performance.now() / 1000;

function loop() {
    frames++;
    const sinceStats = performance.now() - statsStart;
    // `?stats` (implied by `?crowd`, which exists to be measured) reports frame time.
    // Left on unconditionally it prints into everyone's console forever.
    if (state.options.stats && sinceStats > 3000) {
        console.log(`FRAMETIME ${(sinceStats / frames).toFixed(2)}ms  (${((1000 * frames) / sinceStats).toFixed(0)} fps)`);
        frames = 0;
        statsStart = performance.now();
    }
    const now = performance.now() / 1000;
    // Clamped so a stall or a tab-switch can't teleport the crowd.
    const dt = Math.min(now - lastTime, 0.1);
    lastTime = now;
    update(state, now, dt);
    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
