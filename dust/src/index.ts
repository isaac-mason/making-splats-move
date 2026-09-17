import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createCameraDrift } from './camera-drift';
import { createDust } from './dust';
import { applyPerformance, initPerformance } from './performance';
import { CAMERA_POSITION, CAMERA_TARGET, DUST_BOX } from './scene';
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

    // Splats are self-lit and the dust motes are splats too, so this scene has no
    // three.js lights in it at all.
    const { spark, mesh: splat } = createSplat(scene, renderer);

    // The dust field. A SplatGenerator is a scene node like any other, and its
    // motes are sorted and blended together with the greenhouse's own splats.
    const dust = createDust(DUST_BOX);
    scene.add(dust.object);
    console.log(`dust: ${dust.count.toLocaleString()} motes`);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    const perf = initPerformance();

    // A gentle lean toward the cursor while hovering (mouse only — see the file).
    const drift = createCameraDrift(camera, controls, renderer.domElement);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, camera, renderer, spark, splat, dust, controls, perf, drift };
}

type State = ReturnType<typeof init>;

function update(state: State, dt: number) {
    // Drives controls.update() itself, so the lean can't compound into its state.
    state.drift.apply(dt);
    applyPerformance(state.perf, state.spark);
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

    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;
    hideLoading();

    let last = performance.now();

    function loop() {
        const now = performance.now();
        // Clamp so a tab-switch can't fling the camera across the room on resume.
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        update(state, dt);
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
