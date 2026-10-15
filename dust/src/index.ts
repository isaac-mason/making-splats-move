/**
 * Dust motes drifting through a captured greenhouse: splats generated on the GPU,
 * sorted and blended in with the capture's own.
 *
 * Drawn by spark-radix on three's WebGPURenderer: WebGPU where there is one, its
 * WebGL2 backend elsewhere (or with `?gpu=webgpu-gl`).
 */

import { type AnySplatObject, createRenderer, SplatCollection, SplatRenderer } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCameraDrift } from './camera-drift';
import { createDebugOverlay, updateDebugOverlay } from './debug';
import { createDust } from './dust';
import { createDustPoints } from './dust-points';
import { applyPerformance, initPerformance } from './performance';
import { CAMERA_POSITION, CAMERA_TARGET, DUST_BOX } from './scene';
import { createSplat } from './splat';
import './style.css';

/** So a stall or a tab switch can't fling the camera across the room on resume. */
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

    // Splats are self-lit and the dust motes are splats too, so this scene has no
    // three.js lights in it at all.
    const splat = await createSplat(renderer);

    // The dust field: one object in the same collection as the greenhouse, so its
    // motes are sorted and blended together with the greenhouse's own splats.
    const dust = createDust(DUST_BOX);
    console.log(`dust: ${dust.count.toLocaleString()} motes`);

    const splats = new SplatRenderer({ renderer });
    splats.raycast = () => {};
    scene.add(splats);

    // The same field as a sprite cloud, hidden unless switched on in the debug
    // panel — there to show what goes wrong without splats (see the file). It's
    // spread past the walls on purpose: splat motes out there would be hidden by
    // the room, so the sprites showing through it is the failure made plain.
    const dustPoints = createDustPoints(DUST_BOX.clone().expandByVector(new THREE.Vector3(15, 3, 15)));
    scene.add(dustPoints.object);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    const perf = initPerformance();

    // A gentle lean toward the cursor while hovering (mouse only — see the file).
    const drift = createCameraDrift(camera, controls, renderer.domElement);

    // Debug panel: toggle with the backtick (`) key. Hiding the dust takes its
    // motes out of the collection entirely, not just off screen.
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
        /** Which layers the collection was last built from. */
        shown: '',
        dustPoints,
        controls,
        perf,
        drift,
        debug,
    };
    return state;
}

type State = Awaited<ReturnType<typeof init>>;

/**
 * The renderer draws an immutable collection, so hiding a layer means a new one.
 * Only when the toggle changes: making one compiles nothing, but it's no per-frame job.
 */
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
    applyPerformance(state.perf, state.renderer);
    state.dustPoints.update(dt, state.camera, state.renderer);
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.splats.collection.count, dt);

    // The GPU sort sees the motes move every frame. The WebGL2 backend's CPU sort
    // doesn't, so ask it each frame: the dust never stops.
    if (state.splats.sortMode === 'cpu') state.splats.requestSort();
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

    let last = performance.now();
    let elapsed = 0;
    let frames = 0;

    state.renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;
        elapsed += dt;
        update(state, elapsed, dt);

        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) hideLoading();
    });
}

start();
