import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { attachDebugRaycast, createDebugOverlay, updateDebugOverlay } from './debug';
import { applyPerformance, initPerformance } from './performance';
import { CAMERA_POSITION, CAMERA_TARGET } from './scene';
import { createSplat } from './splat';
import './style.css';

function init() {
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // antialias: false is recommended for Spark — MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // SparkRenderer + the scene's SplatMesh, with the wind modifier attached.
    // Splats are self-lit, and nothing else in this scene is a mesh, so there are
    // no three.js lights here at all.
    const { spark, mesh: splat } = createSplat(scene, renderer);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    // Runtime perf/quality settings (LOD budget, …); the debug panel tweaks these.
    const perf = initPerformance();

    // Debug panel: toggle with the backtick (`) key. Wind-sphere wireframes, LOD
    // sliders, click-to-raycast, and a click-to-copy camera readout.
    const debug = createDebugOverlay(perf);
    scene.add(debug.raycastMarker);
    scene.add(debug.windSpheres);
    attachDebugRaycast(debug, camera, scene, renderer.domElement);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, camera, renderer, spark, splat, controls, perf, debug };
}

type State = ReturnType<typeof init>;

function update(state: State) {
    state.controls.update();

    // Push runtime perf settings (LOD budget, …) onto the renderer.
    applyPerformance(state.perf, state.spark);
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.spark);
    state.renderer.render(state.scene, state.camera);
}

// Fade out + remove the loading overlay once everything's ready.
function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

// `splat.initialized` only means the file is decoded — the splats aren't on
// screen until Spark has sorted them and streamed in the LOD pages. The render
// loop drives that, and `spark.activeSplats` climbs from 0 as splats become
// renderable. So we run the loop with the overlay still up and lift it once that
// count crosses a fraction of the model's total. Expressed as a fraction (not a
// raw count) so it scales if the asset changes; timeout is a backstop in case
// frustum culling / LOD plateaus the count below the threshold.
const SPLAT_READY_FRACTION = 0.8; // lift once this share of the model's splats are rendered
const SPLAT_WAIT_TIMEOUT_MS = 10000; // ... but never keep the loader up longer than this

async function start() {
    const state = init();

    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;

    let loaderUp = true;
    const startedAt = performance.now();

    function loop() {
        update(state); // renders the frame, which drives Spark's sort + LOD streaming

        if (loaderUp) {
            const now = performance.now();
            const active = state.spark.activeSplats;
            const total = state.splat.numSplats;
            const ready = total > 0 && active >= total * SPLAT_READY_FRACTION;
            if (ready || now - startedAt >= SPLAT_WAIT_TIMEOUT_MS) {
                loaderUp = false;
                console.log(`splats ready: ${active}/${total} active${ready ? '' : ' (timed out)'}`);
                hideLoading();
            }
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
