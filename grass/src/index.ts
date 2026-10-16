/**
 * A meadow at golden hour, every splat of it procedural: a ground of flat splats
 * and long grass waving in gusts that roll across the field (field.ts). The sun
 * sits low beyond the field, so the blades are backlit and their tips glow, and
 * the far field fades into a haze that is also the sky's horizon.
 *
 * Drawn by spark-radix on three's WebGPURenderer: WebGPU where there is one, its
 * WebGL2 backend elsewhere (or with `?gpu=webgpu-gl`). Drag to look around.
 */

import { createRenderer, SplatCollection, SplatRenderer, TSL } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { HAZE, initField, SUN_DIRECTION, updateField } from './field';
import './style.css';

const { dot, max, mix, normalize, pass, positionWorldDirection, pow, screenUV, smoothstep, uniform, vec4 } = TSL;

/* the shot */

/** Eye height in the grass, looking out across it towards the sun. */
const CAMERA_POSITION = new THREE.Vector3(0, 1.45, 3);
const CAMERA_TARGET = new THREE.Vector3(0.6, 0.75, -8);

/** So a stall or a tab switch can't jump the wind forward. */
const MAX_DT = 0.1;
/** Splats are fill-bound: past this, more pixels cost more than they show. */
const MAX_PIXEL_RATIO = 1.5;

/* the sky */

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

const SKY = {
    horizon: srgb(...HAZE),
    zenith: srgb(0.45, 0.58, 0.78),
    /** Below the horizon, beyond the field: the haze, a little deeper. */
    below: srgb(0.78, 0.62, 0.45),
    sun: srgb(1, 0.9, 0.72),
};

/**
 * A gradient by elevation, the horizon in the haze colour, with the sun's disc
 * and two glows round it. The disc is far past 1, so the bloom finds it.
 */
function skyNode() {
    const dir = normalize(positionWorldDirection);
    const up = dir.y;
    const sky = mix(uniform(SKY.horizon), uniform(SKY.zenith), smoothstep(0.0, 0.5, up));
    const ground = mix(uniform(SKY.horizon), uniform(SKY.below), smoothstep(0.0, -0.25, up));
    const base = up.greaterThan(0).select(sky, ground);

    const toSun = max(dot(dir, uniform(SUN_DIRECTION)), 0);
    const disc = smoothstep(0.9994, 0.9997, toSun).mul(14);
    const glow = pow(toSun, 60).mul(0.9).add(pow(toSun, 6).mul(0.22));
    return base.add(uniform(SKY.sun).mul(disc.add(glow)));
}

/* post */

const BLOOM = { strength: 0.22, radius: 0.5, threshold: 0.85 };
const VIGNETTE = 0.28;

/**
 * Splats blend sRGB-encoded but land in the pass decoded to linear, so the output
 * encodes back to sRGB with no tone mapping, plus a bloom and a vignette.
 */
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

    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 500);
    camera.position.copy(CAMERA_POSITION);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(CAMERA_TARGET);
    controls.enableDamping = true;
    controls.enablePan = false;
    // Stay standing in the field: never under it, never far above it.
    controls.minPolarAngle = 0.9;
    controls.maxPolarAngle = 1.5;
    controls.minDistance = 4;
    controls.maxDistance = 16;
    controls.update();

    const field = initField();
    const splats = new SplatRenderer({ renderer });
    splats.collection = new SplatCollection(field.objects);
    scene.add(splats);

    const pipeline = initPost(renderer, scene, camera);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    let last = performance.now();
    let elapsed = 0;
    let frames = 0;
    renderer.setAnimationLoop(() => {
        const now = performance.now();
        elapsed += Math.min((now - last) / 1000, MAX_DT);
        last = now;
        controls.update();
        updateField(elapsed, camera);
        // The WebGL2 backend sorts on the CPU and only when asked; everything moves.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
