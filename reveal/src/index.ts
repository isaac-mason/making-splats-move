import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { type CameraMove, initCameraMove, updateCameraMove } from './camera-move';
import { createDebugOverlay, type DebugOverlay, updateDebugOverlay } from './debug';
import { finishLoading, initLoading, type Loading, setLoadingProgress } from './loading';
import { applyPerformance, sparkQuality } from './performance';
import { armReveal, initReveal, type Reveal, replayReveal, updateReveal } from './reveal';
import { CAMERA_POSITION, CAMERA_TARGET, SKY, SPLAT_URL } from './scene';
import { url } from './url';
import './style.css';

// A 96MB Gaussian-splat city that puts itself together out of a single point the
// moment it finishes downloading.
//
// `?cam=x,y,z`, `?look=x,y,z` and `?origin=x,y,z` move the framing and the point it
// grows from; `?t=2.5` freezes the wavefront at one moment, which is the only way to
// judge a still frame of something that takes five seconds.
//
// The reveal is a `GsplatModifier` — see reveal.ts for why that rather than Spark's
// built-in SDF edits, which can fade a sphere in but can't send each splat along its
// own radius.

type State = {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    spark: SparkRenderer;
    reveal: Reveal;
    move: CameraMove;
    loading: Loading;
    debug: DebugOverlay;
    mesh: SplatMesh;
};

function init(): State {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.copy(url.vector('cam') ?? new THREE.Vector3(...CAMERA_POSITION));

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const spark = new SparkRenderer({ renderer, ...sparkQuality() });
    scene.add(spark);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.copy(url.vector('look') ?? new THREE.Vector3(...CAMERA_TARGET));
    controls.update();

    // Resident, not `paged: true`. Paging streams the file and starts instantly,
    // which is the right call for wind/ and exactly wrong here — the whole demo is
    // the moment a long download lands.
    const loading = initLoading();
    const mesh = new SplatMesh({
        url: SPLAT_URL,
        onProgress: (event) => setLoadingProgress(loading, event),
    });
    scene.add(mesh);

    const reveal = initReveal(mesh, url.vector('origin'));
    const debug = createDebugOverlay(() => replayReveal(reveal));
    mesh.initialized.then(() => armReveal(reveal));

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, camera, renderer, controls, spark, reveal, move: initCameraMove(renderer.domElement), loading, debug, mesh };
}

function update(state: State, dt: number): void {
    applyPerformance(state.spark);
    // The overlay lifts on the frame the first splats are actually drawn, not when
    // the file finished downloading — see SEED in reveal.ts.
    // `?t=2.5` freezes the wavefront, so a still frame catches an exact moment of
    // the reveal rather than whatever the timer happened to be on.
    const wasRunning = state.reveal.running;
    updateReveal(state.reveal, dt, state.spark.activeSplats > 0, url.number('t'));
    if (state.reveal.running && !wasRunning) finishLoading(state.loading);
    updateCameraMove(state.move, state.camera, state.controls, dt);
    state.controls.update();
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.spark, state.reveal, dt);
    state.renderer.render(state.scene, state.camera);
}

const state = init();
let lastTime = performance.now() / 1000;

function loop() {
    const now = performance.now() / 1000;
    // Clamped so a stall can't jump the wavefront across the whole city.
    const dt = Math.min(now - lastTime, 0.1);
    lastTime = now;
    update(state, dt);
    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
