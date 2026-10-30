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

    const wind = createWind();
    const splat = await createSplat(scene, renderer, wind.modifier);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = false;
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    const drift = createCameraDrift(camera, controls, renderer.domElement);

    const perf = initPerformance();
    const stats = initStats();

    const debug = createDebugOverlay(perf, {
        onOrbitChange: (orbit) => {
            controls.enabled = orbit;
            if (orbit) return;
            drift.clear();
            camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);
            controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
        },
    });

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
    // Replaces controls.update(): the tilt must follow it, since update() rewrites orientation.
    state.drift.apply(dt, !state.debug.orbit);

    applyPerformance(state.perf, state.renderer);
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.splat.count, state.perf);

    // The WebGL2 backend's CPU sort only runs when asked.
    const { splats } = state.splat;
    if (splats.sortMode === 'cpu' && state.wind.moving()) splats.requestSort();
    state.renderer.render(state.scene, state.camera);
}

function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700);
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

        if (++frames === 3) hideLoading();
    });
}

start();
