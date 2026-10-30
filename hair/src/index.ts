import { createRenderer, SplatCollection, SplatRenderer, TSL } from '@sparkjsdev/radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { initHair, SUN_DIRECTION, updateHair } from './hair';
import './style.css';

const {
    abs,
    dot,
    max,
    mix,
    mx_noise_float,
    normalize,
    pass,
    positionWorldDirection,
    pow,
    screenUV,
    smoothstep,
    time,
    uniform,
    vec3,
    vec4,
} = TSL;

/* the camera */

const VIEW = {
    target: new THREE.Vector3(0, 1.48, 0.02),
    from: new THREE.Vector3(-0.574, 0.1, 0.819),
    distance: 1.4,
    near: 0.85,
    far: 1.9,
    fov: 40,
    around: 1.05,
    polar: [1.25, 1.75],
};

/** So a stall or a tab switch can't throw the hair. */
const MAX_DT = 1 / 20;
/** Splats are fill-bound: past this, more pixels cost more than they show. */
const MAX_PIXEL_RATIO = 1.5;

/* the sky and the sea */

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

const SKY = {
    horizon: srgb(0.99, 0.8, 0.6),
    zenith: srgb(0.36, 0.5, 0.74),
    sun: srgb(1, 0.9, 0.72),
    seaFar: srgb(0.72, 0.62, 0.58),
    seaNear: srgb(0.16, 0.22, 0.3),
};

function skyNode() {
    const dir = normalize(positionWorldDirection);
    const up = dir.y;
    const sun = uniform(SUN_DIRECTION);
    const sky = mix(uniform(SKY.horizon), uniform(SKY.zenith), smoothstep(0.0, 0.55, up));
    const toSun = max(dot(dir, sun), 0);
    const disc = smoothstep(0.9993, 0.9996, toSun).mul(10);
    const glow = pow(toSun, 40).mul(0.8).add(pow(toSun, 5).mul(0.25));

    const sea = mix(uniform(SKY.seaFar), uniform(SKY.seaNear), pow(smoothstep(0, -0.35, up), 0.6));
    const flat = normalize(vec3(dir.x, 0, dir.z));
    const sunFlat = normalize(vec3(SUN_DIRECTION.x, 0, SUN_DIRECTION.z));
    const path = pow(max(dot(flat, sunFlat), 0), 300).mul(smoothstep(-0.3, -0.005, up));
    const swell = mx_noise_float(vec3(dir.x.mul(90), dir.y.mul(400), time.mul(0.6)));
    const glitter = path.mul(smoothstep(0.1, 0.6, swell).mul(1.6).add(0.25));
    const haze = smoothstep(0.03, 0, abs(up)).mul(0.35);

    const above = sky.add(uniform(SKY.sun).mul(disc.add(glow)));
    const below = sea.add(uniform(SKY.sun).mul(glitter.add(glow.mul(0.5))));
    return mix(up.greaterThan(0).select(above, below), uniform(SKY.horizon), haze);
}

/* post */

const BLOOM = { strength: 0.3, radius: 0.55, threshold: 0.8 };
const VIGNETTE = 0.32;

function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): RenderPipeline {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);
    const color = pass(scene, camera).getTextureNode('output');
    const glow = bloom(color, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    const vignette = smoothstep(0.35, 1.0, screenUV.sub(0.5).length().mul(1.35)).mul(VIGNETTE).oneMinus();
    pipeline.outputNode = vec4(color.add(glow).rgb.mul(vignette), 1);
    return pipeline;
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = skyNode();

    const camera = new THREE.PerspectiveCamera(VIEW.fov, window.innerWidth / window.innerHeight, 0.02, 100);
    camera.position.copy(VIEW.from).normalize().multiplyScalar(VIEW.distance).add(VIEW.target);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(VIEW.target);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minAzimuthAngle = -VIEW.around;
    controls.maxAzimuthAngle = VIEW.around;
    controls.minPolarAngle = VIEW.polar[0];
    controls.maxPolarAngle = VIEW.polar[1];
    controls.minDistance = VIEW.near;
    controls.maxDistance = VIEW.far;
    controls.update();

    const hair = initHair();
    const splats = new SplatRenderer({ renderer });
    splats.collection = new SplatCollection(hair.objects);
    scene.add(splats);

    const pipeline = initPost(renderer, scene, camera);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    let last = performance.now();
    let frames = 0;
    renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;
        controls.update();
        updateHair(hair, dt, camera);
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
