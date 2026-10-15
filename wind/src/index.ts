/**
 * Wind-swayed trees in a Gaussian-splat city: a per-splat sway modifier on the
 * capture's generator, masked by authored volumes (src/wind.ts), with an editor
 * for placing them (src/wind-editor.ts).
 *
 * Drawn by spark-radix on three's WebGPURenderer: WebGPU where there is one, its
 * WebGL2 backend elsewhere (or with `?gpu=webgpu-gl`).
 */

import { createRenderer } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createCameraDrift } from './camera-drift';
import { createDebugOverlay, updateDebugOverlay } from './debug';
import { applyPerformance, initPerformance } from './performance';
import { CAMERA_POSITION, CAMERA_TARGET } from './scene';
import { createSplat } from './splat';
import { initStats, tickStats } from './stats';
import './style.css';
import { createWind } from './wind';
import { createWindEditor } from './wind-editor';

/** So a stall or a tab switch can't jump the camera lean forward. */
const MAX_DT = 0.1;

async function init() {
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // The capture, with the wind modifier on its generator. Splats are self-lit,
    // and the only other meshes are unlit debug wireframes, so there are no
    // three.js lights in this scene at all.
    const wind = createWind();
    const splat = await createSplat(scene, renderer, wind.modifier);

    const controls = new OrbitControls(camera, renderer.domElement);
    // Off by default. The shipped camera is the fixed framing plus the parallax
    // lean below — that's the shot. Free-look is a framing and authoring tool, so
    // it lives behind the debug panel's `orbit camera` toggle.
    controls.enabled = false;
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    // A gentle tilt toward the cursor while hovering (mouse only — see the file
    // for why this scene pans rather than parallaxes). Drives controls.update().
    const drift = createCameraDrift(camera, controls, renderer.domElement);

    const perf = initPerformance();
    const stats = initStats();

    // Debug panel: toggle with the backtick (`) key. A click-to-copy camera
    // readout, the render scale, and the wind edit-mode switch.
    const debug = createDebugOverlay(perf, {
        onOrbitChange: (orbit) => {
            controls.enabled = orbit;
            if (orbit) return;
            // Handing the camera back to the presentation shot, from wherever the
            // last orbit drag left it. Drop the tilt too, so it doesn't ease back
            // from a stale value once the cursor moves again.
            drift.clear();
            camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);
            controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
        },
    });

    // Authoring UI for the wind volumes: gizmo, sphere list, live parameters, and
    // a JSON box to copy the result back into src/wind.json. Off until toggled.
    const windEditor = createWindEditor({
        wind,
        scene,
        camera,
        controls,
        domElement: renderer.domElement,
        orbitEnabled: () => debug.orbit,
    });
    debug.onEditWind = (enabled) => windEditor.setEnabled(enabled);
    debug.onWindEnabled = (enabled) => wind.setEnabled(enabled);
    debug.onHighlightLeaves = (enabled) => windEditor.setHighlight(enabled);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, camera, renderer, splat, wind, controls, drift, perf, debug, windEditor, stats };
}

type State = Awaited<ReturnType<typeof init>>;

function update(state: State, time: number, dt: number) {
    tickStats(state.stats);
    state.wind.tick(time);
    // Replaces controls.update(): the tilt has to be applied after it, since
    // update() rewrites the camera's orientation from position and target every
    // frame. While free-look is on the tilt stands down, so the two never fight.
    state.drift.apply(dt, !state.debug.orbit);

    applyPerformance(state.perf, state.renderer);
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.splat.count, state.perf);

    // The GPU sort sees the sway every frame. The WebGL2 backend's CPU sort
    // doesn't, so ask it each frame while anything moves.
    const { splats } = state.splat;
    if (splats.sortMode === 'cpu' && state.wind.moving()) splats.requestSort();
    state.renderer.render(state.scene, state.camera);
}

function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

async function start() {
    const state = await init();

    const startedAtMs = performance.now();
    let lastMs = startedAtMs;
    let frames = 0;

    state.renderer.setAnimationLoop(() => {
        const nowMs = performance.now();
        const dt = Math.min((nowMs - lastMs) / 1000, MAX_DT);
        lastMs = nowMs;
        update(state, (nowMs - startedAtMs) / 1000, dt);

        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) hideLoading();
    });
}

start();
