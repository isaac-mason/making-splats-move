/**
 * A campfire in a captured clearing: a procedural flame, smoke, embers and
 * fireflies, all splats generated on the GPU, sorted in with the scene's own. The
 * fire lights the clearing and shimmers the air above it, and a tap stokes it.
 */

import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCameraDrift } from './camera-drift';
import { attachDebugRaycast, createDebugOverlay, updateDebugOverlay } from './debug';
import { initEmbers, updateEmbers } from './embers';
import { initFire, stokeFire, updateFire } from './fire';
import { initFireflies } from './fireflies';
import { initFlame, updateFlame } from './flame';
import { initHeat, updateHeat } from './heat';
import { attachInteraction } from './interaction';
import { initLighting, updateLighting } from './lighting';
import { applyPerformance, initPerformance } from './performance';
import { CAMERA_POSITION, CAMERA_TARGET, SPLAT_URL } from './scene';
import { initSmoke, updateSmoke } from './smoke';
import './style.css';

/** Lift the loader once this share of the splats is on screen, or after this long regardless. */
const SPLAT_READY_FRACTION = 0.8;
const SPLAT_WAIT_TIMEOUT_MS = 10000;
/** So a stall or a tab switch can't jump the animation forward. */
const MAX_DT = 0.1;

function init() {
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(...CAMERA_POSITION);

    // MSAA doesn't help splats, and costs.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
        minAlpha: 0.15 / 255,
    });
    // SparkRenderer is itself a quad mesh at the origin, so a debug raycast would
    // report hits on a plane at z=0 instead of on the scene.
    spark.raycast = () => {};
    scene.add(spark);

    // `.rad` gives LOD either way; `paged` STREAMS it, for an instant start and the
    // paging budget. Pages come by HTTP range request, so the host must support them.
    const splat = new SplatMesh({ url: SPLAT_URL, paged: true });
    scene.add(splat);

    const heat = initHeat();
    splat.worldModifier = heat.modifier;

    const controls = new OrbitControls(camera, renderer.domElement);
    // The shot is the fixed framing plus the parallax lean; free-look is a measuring
    // tool, behind the debug panel's `orbit camera`.
    controls.enabled = false;
    controls.enableDamping = true;
    controls.target.set(...CAMERA_TARGET);
    controls.update();

    const drift = createCameraDrift(camera, controls, renderer.domElement);
    const perf = initPerformance();

    const debug = createDebugOverlay(perf, {
        onOrbitChange: (orbit) => {
            controls.enabled = orbit;
            if (orbit) return;
            // Back to the presentation shot. Clear the lean first, or the offset it
            // holds stays baked into the position set out from under it.
            drift.clear();
            camera.position.set(...CAMERA_POSITION);
            controls.target.set(...CAMERA_TARGET);
        },
    });
    scene.add(debug.raycastMarker);
    attachDebugRaycast(debug, camera, scene, renderer.domElement);

    const fire = initFire();

    const lighting = initLighting();
    scene.add(lighting.coreLayer, lighting.coreHelper, lighting.ambientLayer, lighting.ambientHelper, lighting.pointLight);

    const flame = initFlame();
    const smoke = initSmoke(fire);
    const embers = initEmbers();
    const fireflies = initFireflies();
    scene.add(flame.object, smoke.object, embers.object, fireflies.object);

    // While the debug panel is open, clicks raycast instead.
    attachInteraction(renderer.domElement, {
        onStoke: () => stokeFire(fire),
        enabled: () => !debug.enabled,
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        spark,
        splat,
        controls,
        drift,
        debug,
        perf,
        lighting,
        heat,
        flame,
        smoke,
        embers,
        fireflies,
        fire,
    };
}

type State = ReturnType<typeof init>;

function update(state: State, time: number, dt: number) {
    const { debug, fire, lighting } = state;

    // First, so every system reads this frame's heat.
    fire.override = debug.heatOverride;
    updateFire(fire, dt);

    // Spark only gathers visible generators and edits, so hiding one takes it out entirely.
    state.flame.object.visible = debug.fireEnabled;
    state.embers.object.visible = debug.embersEnabled;
    state.smoke.object.visible = debug.smokeEnabled;
    state.fireflies.object.visible = debug.firefliesEnabled;
    lighting.coreLayer.visible = debug.lightingEnabled;
    lighting.ambientLayer.visible = debug.lightingEnabled;
    lighting.pointLight.visible = debug.lightingEnabled;

    updateFlame(state.flame, fire);
    updateSmoke(state.smoke, fire, dt);
    updateEmbers(state.embers, fire);
    // In place of controls.update(). The lean stands down while free-look is on.
    state.drift.apply(dt, !debug.orbit);
    updateLighting(lighting, fire, time, debug.showLights);
    updateHeat(state.heat, fire);
    applyPerformance(state.perf, state.spark);
    updateDebugOverlay(debug, state.camera, state.controls, fire, state.spark);
    state.renderer.render(state.scene, state.camera);
}

function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

async function start() {
    const state = init();
    await state.splat.initialized;

    let lastTime = performance.now();
    let elapsed = 0;
    let loaderUp = true;
    const startedAt = performance.now();

    function loop() {
        const now = performance.now();
        const dt = Math.min((now - lastTime) / 1000, MAX_DT);
        lastTime = now;
        elapsed += dt;
        update(state, elapsed, dt);

        // Decoded isn't on screen: splats appear as Spark sorts them and streams LOD
        // pages in, which the render loop drives. So the loader stays up, with the
        // loop running, until enough of them are active.
        if (loaderUp) {
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
