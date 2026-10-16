/**
 * A campfire in a captured clearing: a procedural flame, smoke, embers and
 * fireflies, all splats generated on the GPU, sorted in with the scene's own. The
 * fire lights the clearing and shimmers the air above it, and a tap stokes it.
 *
 * Drawn by spark-radix on three's WebGPURenderer: WebGPU where there is one, its
 * WebGL2 backend elsewhere (or with `?gpu=webgpu-gl`). On WebGPU the flame, smoke
 * and embers ride a fluid simulation (sim.ts); elsewhere, or with `?sim=0`, they're
 * the stateless closed-form particles.
 */

import {
    type AnySplatObject,
    createRenderer,
    GpuArrays,
    getGpuCaps,
    loadSplats,
    SplatCollection,
    SplatGenerator,
    SplatRenderer,
} from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { type Air, initAir, updateAir } from './air';
import { createCameraDrift } from './camera-drift';
import { initCoals, updateCoals } from './coals';
import { attachDebugRaycast, createDebugOverlay, updateDebugOverlay } from './debug';
import { initEmbers } from './embers';
import { type Fire, initFire, stokeFire, updateFire } from './fire';
import { initFireflies } from './fireflies';
import { initFlame, updateFlame } from './flame';
import { initHeat, updateHeat } from './heat';
import { attachInteraction } from './interaction';
import { initLighting, NIGHT_BRIGHTNESS, updateLighting } from './lighting';
import { applyPerformance, initPerformance } from './performance';
import { BLOOM_STRENGTH, initPost } from './post';
import { createSplatPicker, type SplatPicker } from './raycast';
import { download, type Recording, record, recordingFromUrl } from './record';
import { CAMERA_POSITION, CAMERA_TARGET, SPLAT_URL } from './scene';
import { initFireSim } from './sim';
import { initSmoke, updateSmoke } from './smoke';
import { time } from './tsl';
import './style.css';

/** So a stall or a tab switch can't jump the animation forward. */
const MAX_DT = 0.1;
/** `?record`: render a take on a fixed clock into an MP4 instead of running live (record.ts). */
const RECORDING = recordingFromUrl();

async function init() {
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(...CAMERA_POSITION);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    // Decoded on a worker.
    const data = await loadSplats(SPLAT_URL);
    const arrays = GpuArrays.fromData(renderer, data);

    // The lighting and the heat shimmer are modifiers on the capture's own
    // generator, not the renderer's, so the fire's particles are left alone. The
    // capture sits at the origin, so its object space is world space.
    const heat = initHeat();
    const lighting = initLighting();
    const capture = SplatCollection.object({
        generator: SplatGenerator.fromSplats({ modifiers: [lighting.modifier, heat.modifier] }),
        data: { splats: arrays },
        count: arrays.count,
    });

    const splats = new SplatRenderer({ renderer, params: { minAlpha: 0.15 / 255 } });
    // A mesh to three, but there's nothing to hit: debug clicks go through the picker.
    splats.raycast = () => {};
    scene.add(splats);

    const controls = new OrbitControls(camera, renderer.domElement);
    // The shot is the fixed framing plus the parallax lean; free-look is a measuring
    // tool, behind the debug panel's `orbit camera`.
    controls.enabled = false;
    controls.enableDamping = true;
    controls.target.set(...CAMERA_TARGET);
    controls.update();

    const drift = createCameraDrift(camera, controls, renderer.domElement);
    const perf = initPerformance();

    const debug = createDebugOverlay(
        perf,
        { night: NIGHT_BRIGHTNESS, bloom: BLOOM_STRENGTH },
        {
            onOrbitChange: (orbit) => {
                controls.enabled = orbit;
                if (orbit) return;
                // Back to the presentation shot. Clear the lean first, or the offset it
                // holds stays baked into the position set out from under it.
                drift.clear();
                camera.position.set(...CAMERA_POSITION);
                controls.target.set(...CAMERA_TARGET);
            },
        },
    );
    scene.add(debug.raycastMarker);

    // Built on the first measuring click: it keeps a copy of every centre.
    let picker: SplatPicker | null = null;
    const pick = (ray: THREE.Ray) => {
        picker ??= createSplatPicker(data);
        return picker.intersect(ray);
    };
    attachDebugRaycast(debug, camera, pick, renderer.domElement);

    const fire = initFire();
    scene.add(lighting.coreHelper, lighting.ambientHelper, lighting.pointLight);

    const air = initAir(fire);
    const simulate = getGpuCaps(renderer).compute && new URLSearchParams(location.search).get('sim') !== '0';
    const effects = simulate ? initFireSim(renderer) : initStateless(air);
    const coals = initCoals();
    const fireflies = initFireflies();

    // While the debug panel is open, clicks raycast instead.
    attachInteraction(renderer.domElement, {
        onStoke: () => stokeFire(fire),
        enabled: () => !debug.enabled,
    });

    window.addEventListener('resize', () => {
        if (RECORDING) return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        post: initPost(renderer, scene, camera),
        splats,
        capture,
        /** Which layers the collection was last built from. */
        shown: '',
        controls,
        drift,
        debug,
        perf,
        lighting,
        heat,
        air,
        effects,
        coals,
        fireflies,
        fire,
    };
}

type State = Awaited<ReturnType<typeof init>>;

/** The closed-form particles, in the simulation's shape: for WebGL2, or `?sim=0`. */
function initStateless(air: Air) {
    const flame = initFlame(air);
    const smoke = initSmoke(air);
    const embers = initEmbers(air);
    return {
        flame: flame.object,
        smoke: smoke.object,
        embers: embers.object,
        step(_dt: number, _time: number, fire: Fire) {
            updateFlame(flame, fire);
            updateSmoke(smoke, fire);
        },
    };
}

/**
 * The renderer draws an immutable collection, so hiding a layer means a new one.
 * Only when the toggles change: making one compiles nothing, but it's no per-frame job.
 */
function syncCollection(state: State) {
    const { debug } = state;
    const layers: [boolean, AnySplatObject][] = [
        [true, state.capture],
        [debug.fireEnabled, state.coals.object],
        [debug.fireEnabled, state.effects.flame],
        [debug.smokeEnabled, state.effects.smoke],
        [debug.embersEnabled, state.effects.embers],
        [debug.firefliesEnabled, state.fireflies.object],
    ];
    const shown = layers.map(([on]) => (on ? 1 : 0)).join('');
    if (shown === state.shown) return;
    state.shown = shown;
    state.splats.collection = new SplatCollection(layers.filter(([on]) => on).map(([, object]) => object));
}

function update(state: State, elapsed: number, dt: number, render = true) {
    const { debug, fire, lighting } = state;

    // First, so every system reads this frame's heat.
    fire.override = debug.heatOverride;
    updateFire(fire, dt);
    time.value = elapsed;
    updateAir(state.air, fire, elapsed, dt);

    syncCollection(state);
    state.effects.step(dt, elapsed, fire, state.air.wind);
    updateCoals(state.coals, fire);
    // In place of controls.update(). The lean stands down while free-look is on.
    state.drift.apply(dt, !debug.orbit);
    updateLighting(
        lighting,
        fire,
        elapsed,
        {
            enabled: debug.lightingEnabled,
            showHelpers: debug.showLights,
            night: debug.night,
        },
        state.air.wind,
        state.camera,
    );
    updateHeat(state.heat, fire);
    if (!RECORDING) applyPerformance(state.perf, state.renderer);
    updateDebugOverlay(debug, state.camera, state.controls, fire, state.splats.collection.count, state.perf);

    // The GPU sort sees the particles move every frame. The WebGL2 backend's CPU
    // sort doesn't, so ask it each frame: everything here moves all the time.
    if (state.splats.sortMode === 'cpu') state.splats.requestSort();
    state.post.strength.value = debug.bloom;
    if (render) state.post.pipeline.render();
}

function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

/** The take: the canvas at the recording's size, frames on its clock, stokes on cue, then the download. */
async function recordTake(state: State, recording: Recording) {
    const { renderer, camera } = state;
    renderer.setPixelRatio(1);
    renderer.setSize(recording.width, recording.height, false);
    Object.assign(renderer.domElement.style, { objectFit: 'contain', background: '#000' });
    camera.aspect = recording.width / recording.height;
    camera.updateProjectionMatrix();
    hideLoading();

    const progress = document.createElement('div');
    progress.style.cssText =
        'position:fixed;left:8px;bottom:8px;font:12px monospace;color:#fff;background:rgba(0,0,0,.6);padding:4px 8px';
    document.body.append(progress);

    const stokes = [...recording.stokes];
    let first = true;
    try {
        const blob = await record(
            renderer.domElement,
            recording,
            // `time` is seconds into the take; the warmup comes before it, unrecorded.
            (index, time, dt) => {
                while (stokes.length && stokes[0] <= time) {
                    stokeFire(state.fire);
                    stokes.shift();
                }
                // The scripted mouse sways about the window, through the warmup too, so
                // the lean is already moving on the first frame. Sines at unrelated
                // rates, so it never quite repeats and never reads as a loop.
                const p = (2 * Math.PI * time) / recording.period;
                const x = 0.75 * Math.sin(p) + 0.25 * Math.sin(0.43 * p + 1.7);
                const y = 0.6 * Math.sin(0.71 * p + 0.9) + 0.4 * Math.sin(1.37 * p + 2.6);
                state.drift.drive(x * recording.sweep, y * recording.rise, first);
                first = false;
                update(state, recording.warmup + time, dt, index >= 0);
            },
            (done, total) => {
                progress.textContent = done < 0 ? `warming up ${-done}` : `recording ${done} / ${total}`;
            },
        );
        download(blob, `fire-${recording.width}x${recording.height}-${recording.fps}fps.mp4`);
        progress.textContent = `done: ${(blob.size / 1e6).toFixed(1)} MB`;
    } catch (error) {
        progress.textContent = `recording failed: ${error}`;
        throw error;
    }
}

async function start() {
    const state = await init();
    if (RECORDING) {
        await recordTake(state, RECORDING);
        return;
    }

    let lastTime = performance.now();
    let elapsed = 0;
    let frames = 0;

    state.renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - lastTime) / 1000, MAX_DT);
        lastTime = now;
        elapsed += dt;
        update(state, elapsed, dt);

        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) hideLoading();
    });
}

start();
