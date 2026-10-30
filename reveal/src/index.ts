import { createRenderer, GpuArrays, loadSplats, SplatCollection, SplatGenerator, SplatRenderer } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { WebGPURenderer } from 'three/webgpu';
import { type CameraMove, initCameraMove, updateCameraMove } from './camera-move';
import { createDebugOverlay, type DebugOverlay, updateDebugOverlay } from './debug';
import { finishLoading, initLoading, type Loading, setLoadingProgress } from './loading';
import { type Options, readOptions } from './options';
import { applyPerformance, initPerformance, type Performance, splatParams } from './performance';
import { armReveal, initReveal, type Reveal, replayReveal, updateReveal } from './reveal';
import { CAMERA_POSITION, CAMERA_TARGET, REVEAL_ORIGIN, SKY, SPLAT_URL } from './scene';
import './style.css';

const WARMUP_FRAMES = 2;

type State = {
    options: Options;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: WebGPURenderer;
    controls: OrbitControls;
    splats: SplatRenderer;
    reveal: Reveal;
    move: CameraMove;
    loading: Loading;
    debug: DebugOverlay;
    perf: Performance;
    drawn: number;
};

async function init(): Promise<State> {
    const options = readOptions();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY).convertLinearToSRGB();

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.copy(options.cam ?? new THREE.Vector3(...CAMERA_POSITION));

    const renderer = await createRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const perf = initPerformance();
    const splats = new SplatRenderer({ renderer, params: splatParams() });
    scene.add(splats);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.copy(options.look ?? new THREE.Vector3(...CAMERA_TARGET));
    controls.update();

    const reveal = initReveal(options.origin ?? new THREE.Vector3(...REVEAL_ORIGIN));
    const debug = createDebugOverlay(perf, () => replayReveal(reveal));

    const loading = initLoading();
    loadSplats(SPLAT_URL, { onProgress: (fraction, stage) => setLoadingProgress(loading, fraction, stage) }).then((data) => {
        const arrays = GpuArrays.fromData(renderer, data);
        splats.collection = new SplatCollection([
            SplatCollection.object({
                generator: SplatGenerator.fromSplats({ modifiers: [reveal.modifier] }),
                data: { splats: arrays },
                count: arrays.count,
            }),
        ]);
        armReveal(reveal);
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        options,
        scene,
        camera,
        renderer,
        controls,
        splats,
        reveal,
        move: initCameraMove(renderer.domElement),
        loading,
        debug,
        perf,
        drawn: 0,
    };
}

function update(state: State, dt: number): void {
    applyPerformance(state.perf, state.renderer);
    const wasRunning = state.reveal.running;
    const moved = updateReveal(state.reveal, dt, state.drawn >= WARMUP_FRAMES, state.options.frozenTime);
    if (state.reveal.running && !wasRunning) finishLoading(state.loading);
    // The WebGL2 backend's CPU sort only runs when asked.
    if (moved && state.splats.sortMode === 'cpu') state.splats.requestSort();
    updateCameraMove(state.move, state.camera, state.controls, dt);
    state.controls.update();
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.splats.collection.count, state.reveal, dt);
    state.renderer.render(state.scene, state.camera);
    if (state.splats.collection.count > 0) state.drawn++;
}

async function start() {
    const state = await init();
    let lastTime = performance.now() / 1000;

    state.renderer.setAnimationLoop(() => {
        const now = performance.now() / 1000;
        const dt = Math.min(now - lastTime, 0.1);
        lastTime = now;
        update(state, dt);
    });
}

start();
