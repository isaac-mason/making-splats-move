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

    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
        minAlpha: 0.15 / 255,
    });
    // SparkRenderer is itself a Mesh with quad geometry sitting at the origin, so
    // a debug raycast through it reports hits on a flat plane at z=0 rather than on
    // the scene. It isn't the splat mesh (that raycasts separately), so opting it
    // out costs nothing.
    spark.raycast = () => {};
    scene.add(spark);

    // `paged: true` STREAMS the .rad rather than loading it resident, and that's all
    // it does — the file loads and gives you LOD either way, because `.rad` is an
    // auto-detected format (SplatLoader maps the extension to SplatFileType.RAD) and
    // the LOD tree is encoded in the file. What the flag buys is instant start plus
    // the paging machinery: SplatPager, and with it the `pagedExtSplats` /
    // `maxPagedSplats` budget. Pages are pulled with HTTP range requests, so
    // whatever serves this has to support them.
    const splat = new SplatMesh({ url: SPLAT_URL, paged: true });
    scene.add(splat);

    // Heat shimmer: wobble the scene splats near the fire (see heat.ts).
    const heat = initHeat();
    splat.worldModifier = heat.modifier;

    const controls = new OrbitControls(camera, renderer.domElement);
    // Off by default. The shipped camera is the fixed framing plus the parallax
    // lean below — that's the shot. Free-look is a measuring tool, so it lives
    // behind the debug panel's `orbit camera` toggle.
    controls.enabled = false;
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    // A gentle lean toward the cursor while hovering (mouse only — see the file).
    // Drives controls.update() itself, so the lean can't compound into its state.
    const drift = createCameraDrift(camera, controls, renderer.domElement);

    // Runtime perf/quality settings (LOD budget, …); the debug panel tweaks these.
    const perf = initPerformance();

    const debug = createDebugOverlay(perf, {
        onOrbitChange: (orbit) => {
            controls.enabled = orbit;
            if (orbit) return;
            // Handing the camera back to the presentation shot. Drop the lean
            // first: it holds an offset it subtracts from camera.position each
            // frame, and setting the position out from under it would leave that
            // offset baked in for good.
            drift.clear();
            camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);
            controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
        },
    });
    scene.add(debug.raycastMarker);
    attachDebugRaycast(debug, camera, scene, renderer.domElement);

    // The fire tends itself — a resting burn and self-crackles — and every visual
    // system reads how hot it's burning.
    const fire = initFire();

    const lighting = initLighting();
    scene.add(lighting.coreLayer);
    scene.add(lighting.coreHelper);
    scene.add(lighting.ambientLayer);
    scene.add(lighting.ambientHelper);
    // The SplatEdits above light the splats; this real point light is here so that
    // anything you add with a standard material is lit by the fire too.
    scene.add(lighting.pointLight);

    // The flame body: real splats, so the logs and stones occlude it.
    const flame = initFlame();
    scene.add(flame.object);

    // Smoke above it — its own generator, since it behaves almost opposite to the
    // flame (long-lived, expanding, cooling to nothing).
    const smoke = initSmoke();
    scene.add(smoke.object);

    // Embers as splats, so they sort with the flame and the scene instead of
    // drawing on top of both.
    const embers = initEmbers();
    scene.add(embers.object);

    // Fireflies out in the dark past the fire. They don't read it, so
    // there's no update call — the generator animates itself.
    const fireflies = initFireflies();
    scene.add(fireflies.object);

    // Tap anywhere to throw another log on — unless the debug panel has taken clicks
    // over for raycasting.
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
    // Advance the fire first so every system reads this frame's value.
    state.fire.override = state.debug.heatOverride;
    updateFire(state.fire, dt);

    // Debug-panel toggles. Spark only gathers visible generators and edits, so
    // hiding them is enough to take them out of the frame.
    state.flame.object.visible = state.debug.fireEnabled;
    state.embers.object.visible = state.debug.embersEnabled;
    state.smoke.object.visible = state.debug.smokeEnabled;
    state.fireflies.object.visible = state.debug.firefliesEnabled;
    state.lighting.coreLayer.visible = state.debug.lightingEnabled;
    state.lighting.ambientLayer.visible = state.debug.lightingEnabled;
    state.lighting.pointLight.visible = state.debug.lightingEnabled;

    updateFlame(state.flame, state.fire);
    updateSmoke(state.smoke, state.fire, dt);
    updateEmbers(state.embers, state.fire);
    // Replaces controls.update() — camera-drift.ts has to own it so the lean
    // can't compound into OrbitControls' own state. While free-look is on the
    // lean stands down, so the two never fight over the camera.
    state.drift.apply(dt, !state.debug.orbit);
    updateLighting(state.lighting, state.fire, time, state.debug.showLights);
    updateHeat(state.heat, state.fire);
    applyPerformance(state.perf, state.spark);
    updateDebugOverlay(state.debug, state.camera, state.controls, state.fire, state.spark);
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
const MAX_DT = 0.1; // clamp dt so a stall/tab-switch can't jump the animation forward

async function start() {
    const state = init();

    // Wait for the splat to finish downloading/decoding before the first frame.
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
        update(state, elapsed, dt); // renders the frame, which drives Spark's sort + LOD streaming

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
