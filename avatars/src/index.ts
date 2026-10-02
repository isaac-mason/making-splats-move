/**
 * Procedural characters built from splats and skinned on the GPU with Spark's
 * SplatSkinning — no scan, no mesh, no asset. The README tells the story.
 *
 * Two scenes share the avatar: `courtyard.ts`, the default, and `workbench.ts`, one
 * avatar on a plain stage (`?view`, `?face`, `?editor`, `?crowd=N`).
 */

import { SparkRenderer } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { type Courtyard, courtyardSplats, initCourtyard, updateCourtyard } from './courtyard';
import { createDebugOverlay, updateDebugOverlay } from './debug';
import { type Options, readOptions } from './options';
import { CAMERA_POSITION, CAMERA_TARGET } from './scene';
import { applyTreeSway, createSwayUniforms, type SwayUniforms, setTreeSwayEnabled, tickTreeSway } from './tree-sway';
import { initWorkbench, updateWorkbench, type Workbench, workbenchSplats } from './workbench';
import './style.css';

type State = {
    options: Options;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    spark: SparkRenderer;
    sway: SwayUniforms;
    controls: OrbitControls;
    debug: ReturnType<typeof createDebugOverlay>;
    courtyard: Courtyard | null;
    bench: Workbench | null;
};

function init(): State {
    const options = readOptions();
    const scene = new THREE.Scene();
    // Sky blue in the courtyard, so a hole in the capture's sky reads as sky.
    scene.background = new THREE.Color(options.background ?? (options.courtyard ? 0x8ec8ea : 0x10131a));

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    // The trees' wind is drawn in Spark's splat shader, so its uniforms go in at
    // construction. Harmless in the workbench, which has no trees.
    const sway = createSwayUniforms();
    const spark = new SparkRenderer({ renderer, extraUniforms: sway });
    applyTreeSway(spark);
    scene.add(spark);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    frameCamera(camera, controls, options);

    const debug = createDebugOverlay();

    const bench = options.workbench ? initWorkbench(scene, camera, options) : null;
    const courtyard = options.workbench
        ? null
        : initCourtyard({ scene, camera, domElement: renderer.domElement, controls, debug, options });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { options, scene, camera, renderer, spark, sway, controls, debug, courtyard, bench };
}

/**
 * `?cam` and `?look` win over everything. The named views exist because front-on, a
 * head buried in a chest and a clean join look identical; the side view tells the truth.
 */
function frameCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, options: Options): void {
    const dist = options.face ? 1.55 : 2.8;
    const eyeY = options.face ? 1.34 : 1.15;

    if (options.cam) camera.position.copy(options.cam);
    else if (options.courtyard) camera.position.set(...CAMERA_POSITION);
    else if (options.view === 'front') camera.position.set(0, eyeY, dist);
    else if (options.view === 'side') camera.position.set(dist, eyeY, 0);
    else if (options.view === 'top') camera.position.set(0, eyeY + dist, 0.01);
    // Framed to match reference/avatar-target.png, for side-by-side comparison.
    else if (options.view === 'bust') camera.position.set(0, 1.4, 1.2);
    else camera.position.set(dist * 0.55, eyeY, dist * 0.84);

    if (options.look) controls.target.copy(options.look);
    else if (options.courtyard) controls.target.set(...CAMERA_TARGET);
    else controls.target.set(0, options.view === 'bust' ? 1.4 : options.face ? 1.32 : 0.88, 0);
    controls.update();
}

function update(state: State, time: number, dt: number): void {
    if (state.courtyard) updateCourtyard(state.courtyard, dt);
    if (state.bench) updateWorkbench(state.bench, state.options, state.options.frozenTime ?? time);

    state.controls.update();
    setTreeSwayEnabled(state.sway, state.debug.sway);
    state.sway.treeHighlight.value = state.debug.swayTint ? 1 : 0;
    tickTreeSway(state.spark, state.sway, time);
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.spark, state.courtyard?.crowd ?? null);
    state.renderer.render(state.scene, state.camera);
}

const state = init();
console.log(
    `avatars: ${((state.courtyard ? courtyardSplats(state.courtyard) : 0) + (state.bench ? workbenchSplats(state.bench) : 0)).toLocaleString()} splats`,
);

let frames = 0;
let statsStart = performance.now();
let lastTime = performance.now() / 1000;

function loop() {
    frames++;
    const sinceStats = performance.now() - statsStart;
    if (state.options.stats && sinceStats > 3000) {
        console.log(`FRAMETIME ${(sinceStats / frames).toFixed(2)}ms  (${((1000 * frames) / sinceStats).toFixed(0)} fps)`);
        frames = 0;
        statsStart = performance.now();
    }
    const now = performance.now() / 1000;
    // Clamped, so a tab-switch can't teleport the crowd.
    const dt = Math.min(now - lastTime, 0.1);
    lastTime = now;
    update(state, now, dt);
    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
