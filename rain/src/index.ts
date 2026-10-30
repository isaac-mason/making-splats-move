import { createRenderer, SplatCollection, SplatRenderer, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { initRain } from './drops';
import { loadCourtyard, type Weather } from './wet';
import './style.css';

const {
    Fn,
    dot,
    float,
    fract,
    max,
    mix,
    mx_noise_float,
    normalize,
    pass,
    positionWorldDirection,
    pow,
    screenCoordinate,
    screenUV,
    sin,
    smoothstep,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

const MAX_DT = 0.1;
// Splats are fill-bound: past this, more pixels cost more than they show.
const MAX_PIXEL_RATIO = 1.5;

const VIEW = { position: [10.63, 11, -13.23], target: [0, 0.8, -4.4], fov: 55 };

/* the storm */

const DOWNPOUR: Weather = {
    rainfall: 1,
    wet: 1,
    puddles: 1,
    gloom: [0.58, 0.62, 0.7],
    sky: [0.3, 0.33, 0.38],
};

const WIND = { strength: 3, direction: [0.85, 0.5], gusts: 0.45 };

function windAt(t: number, wind: THREE.Vector2): THREE.Vector2 {
    const gust = 1 + WIND.gusts * (Math.sin(t * 0.31) * 0.65 + Math.sin(t * 1.07 + 1) * 0.35);
    return wind.set(WIND.direction[0], WIND.direction[1]).multiplyScalar(WIND.strength * gust);
}

/* the sky */

const sky = { colour: uniform(new THREE.Vector3(...DOWNPOUR.sky)), time: uniform(0) };

const skyNode = Fn((): TslNode => {
    const dir = normalize(positionWorldDirection).toVar();
    const up = max(dir.y, 0);
    const over = dir.xz
        .div(up.add(0.15))
        .mul(0.5)
        .add(vec2(sky.time.mul(0.02), sky.time.mul(0.012)));
    const cloud = mx_noise_float(vec3(over, sky.time.mul(0.01)))
        .mul(0.5)
        .add(0.5);
    const shade = mix(1.05, 0.78, pow(up, 0.6)).mul(mix(0.88, 1.08, cloud));
    return sky.colour.mul(shade);
});

/* post */

const GRADE = { vignette: 0.35, dither: 1.5 };

function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): RenderPipeline {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);
    const color = pass(scene, camera).getTextureNode('output');
    const vignette = smoothstep(0.35, 1.0, screenUV.sub(0.5).length().mul(1.35)).mul(GRADE.vignette).oneMinus();
    const graded = max(color.rgb.mul(vignette), 0).toVar();
    const noise = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    const step = pow(graded.add(0.0005), vec3(1 - 1 / 2.2)).mul((2.2 / 255) * GRADE.dither);
    // Dither so the grey sky doesn't band.
    pipeline.outputNode = vec4(graded.add(step.mul(noise)), float(1));
    return pipeline;
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = skyNode();
    const camera = new THREE.PerspectiveCamera(VIEW.fov, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(VIEW.position[0], VIEW.position[1], VIEW.position[2]);

    // MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const courtyard = await loadCourtyard(renderer);
    console.log(`rain: ${courtyard.count.toLocaleString()} splats`);
    const rain = initRain(courtyard.reach);
    const splats = new SplatRenderer({ renderer, collection: new SplatCollection([courtyard.object, ...rain.objects]) });
    splats.raycast = () => {};
    scene.add(splats);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(VIEW.target[0], VIEW.target[1], VIEW.target[2]);
    controls.enableDamping = true;
    controls.minDistance = 3;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.update();

    const pipeline = initPost(renderer, scene, camera);
    const wind = new THREE.Vector2();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    let last = performance.now();
    let t = 0;
    let frames = 0;
    renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;
        t += dt;
        controls.update();

        courtyard.update(DOWNPOUR, camera.position, t);
        rain.update(t, camera.position, windAt(t, wind), DOWNPOUR.rainfall, DOWNPOUR.sky);
        sky.time.value = t;

        pipeline.render();
        // Past the first frames' shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
