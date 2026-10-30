import { type AnySplatObject, createRenderer, SplatCollection, SplatRenderer } from '@sparkjsdev/radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCameraDrift } from './camera-drift';
import { createDebugOverlay, updateDebugOverlay } from './debug';
import { createDust } from './dust';
import { createDustPoints } from './dust-points';
import { createFocus } from './focus';
import { applyPerformance, initPerformance } from './performance';
import { CAMERA_POSITION, CAMERA_TARGET, DUST_BOX, SPLAT_SCALE } from './scene';
import { createSplat } from './splat';
import './style.css';

const MAX_DT = 0.1;

const APERTURE_TAN = 0.004;

async function init() {
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    const splat = await createSplat(renderer);

    const dust = createDust(DUST_BOX);
    console.log(`dust: ${dust.count.toLocaleString()} motes`);

    const splats = new SplatRenderer({ renderer, objectParams: { apertureTan: APERTURE_TAN } });
    splats.raycast = () => {};
    scene.add(splats);

    const dustPoints = createDustPoints(DUST_BOX.clone().expandByVector(new THREE.Vector3(15, 3, 15)));
    scene.add(dustPoints.object);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    const perf = initPerformance();

    const drift = createCameraDrift(camera, controls, renderer.domElement);
    const focus = createFocus(splat.data, SPLAT_SCALE, camera, controls, renderer.domElement);

    const debug = createDebugOverlay({
        perf,
        onDustEnabled: (enabled) => {
            state.dustEnabled = enabled;
        },
        onPointsEnabled: (enabled) => {
            dustPoints.object.visible = enabled;
        },
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const state = {
        scene,
        camera,
        renderer,
        splats,
        splat,
        dust,
        dustEnabled: true,
        shown: '',
        dustPoints,
        controls,
        perf,
        drift,
        focus,
        debug,
    };
    return state;
}

type State = Awaited<ReturnType<typeof init>>;

function syncCollection(state: State) {
    const layers: [boolean, AnySplatObject][] = [
        [true, state.splat.object],
        [state.dustEnabled, state.dust.object],
    ];
    const shown = layers.map(([on]) => (on ? 1 : 0)).join('');
    if (shown === state.shown) return;
    state.shown = shown;
    state.splats.collection = new SplatCollection(layers.filter(([on]) => on).map(([, object]) => object));
}

function update(state: State, time: number, dt: number) {
    syncCollection(state);
    state.dust.update(time, dt, state.camera);
    // Drives controls.update() itself, so the lean can't compound into its state.
    state.drift.apply(dt);
    state.splats.objectParams.focalDistance = state.focus.update(dt);
    applyPerformance(state.perf, state.renderer);
    state.dustPoints.update(dt, state.camera, state.renderer);
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.splats.collection.count, dt);

    // The WebGL2 backend's CPU sort only runs when asked.
    if (state.splats.sortMode === 'cpu') state.splats.requestSort();
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

    let last = performance.now();
    let elapsed = 0;
    let frames = 0;

    state.renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;
        elapsed += dt;
        update(state, elapsed, dt);

        if (++frames === 3) hideLoading();
    });
}

start();
