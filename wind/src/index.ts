import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createCameraDrift } from './camera-drift';
import { createDebugOverlay, updateDebugOverlay } from './debug';
import { applyPerformance, initPerformance } from './performance';
import { CAMERA_POSITION, CAMERA_TARGET } from './scene';
import { createSplat } from './splat';
import { initStats, tickStats } from './stats';
import './style.css';
import { applyWind, createWindUniforms, type WindPath } from './wind';
import { createWindEditor } from './wind-editor';

// Two ways to move the same splats, both in src/wind.ts, switchable live.
//
// The default patches Spark's draw-time splat shader and never touches the splat
// buffer. `?generator=1` uses a dyno objectModifier — the idiomatic approach, and
// far more expensive: moving a splat invalidates its sort order, and sorting means
// a GPU depth readback. The README has the numbers.
const WIND_PATH: WindPath = new URLSearchParams(window.location.search).has('generator') ? 'generator' : 'draw-time';

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
    // Splats are self-lit, and the only other meshes are unlit debug wireframes,
    // so there are no three.js lights in this scene at all.
    //
    // The uniforms have to exist before the renderer: they're merged into the
    // splat material at construction, which the draw-time path reads them from.
    const windUniforms = createWindUniforms();
    const { spark, mesh: splat } = createSplat(scene, renderer, { extraUniforms: windUniforms });
    const wind = applyWind(WIND_PATH, spark, splat, windUniforms);
    console.log(`wind path: ${WIND_PATH}`);

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

    // Runtime perf/quality settings (LOD budget, …); the debug panel tweaks these.
    const perf = initPerformance();
    const stats = initStats();

    // Debug panel: toggle with the backtick (`) key. LOD sliders, a click-to-copy
    // camera readout, and the wind edit-mode switch.
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
    // a JSON box to copy the result back into src/wind.ts. Off until toggled.
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

    return { scene, camera, renderer, spark, splat, wind, controls, drift, perf, debug, windEditor, stats };
}

type State = ReturnType<typeof init>;

function update(state: State, time: number, dt: number) {
    tickStats(state.stats);
    state.wind.tick(time);
    // Replaces controls.update(): the tilt has to be applied after it, since
    // update() rewrites the camera's orientation from position and target every
    // frame. While free-look is on the tilt stands down, so the two never fight.
    state.drift.apply(dt, !state.debug.orbit);

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

    const startedAtMs = performance.now();
    let lastMs = startedAtMs;

    function loop() {
        const nowMs = performance.now();
        // Clamped so a stall or a tab-switch can't jump the camera lean forward.
        const dt = Math.min((nowMs - lastMs) / 1000, 0.1);
        lastMs = nowMs;
        update(state, (nowMs - startedAtMs) / 1000, dt); // renders the frame, driving Spark's sort + LOD streaming

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
