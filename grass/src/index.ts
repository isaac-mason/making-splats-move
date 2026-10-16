/**
 * Rolling hills of grass on a summer afternoon, every splat of it procedural
 * (field.ts): wind fronts comb the grass, and clouds drift over with their shadows
 * sweeping across the hills beneath them. The far field fades into a haze that is
 * also the sky's horizon.
 *
 * Drawn by spark-radix on three's WebGPURenderer: WebGPU where there is one, its
 * WebGL2 backend elsewhere (or with `?gpu=webgpu-gl`). Drag to look around.
 */

import { createRenderer, SplatCollection, SplatRenderer, TSL } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { CLOUDS, cloudCover, eye, HAZE, initField, SUN_DIRECTION, terrainHeight, updateField } from './field';
import './style.css';

const { dot, float, max, mix, normalize, pass, positionWorldDirection, pow, screenUV, smoothstep, uniform, vec4 } = TSL;

/* the shot */

/**
 * Standing on a hilltop at eye height, looking out across a valley to the next
 * rise, the sun high to the right. Heights come from the hills themselves.
 */
const EYE_HEIGHT = 1.55;
const LOOK = { angle: (250 * Math.PI) / 180, distance: 20, height: 0.4 };
/** The lowest the camera may get over the grass while you drag it round. */
const MIN_CLEARANCE = 1.1;

/** So a stall or a tab switch can't jump the wind forward. */
const MAX_DT = 0.1;
/** Splats are fill-bound: past this, more pixels cost more than they show. */
const MAX_PIXEL_RATIO = 1.5;

/* the sky */

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

const SKY = {
    horizon: srgb(...HAZE),
    zenith: srgb(0.3, 0.48, 0.78),
    /** Below the horizon, beyond the field: the haze, a little deeper. */
    below: srgb(0.6, 0.66, 0.66),
    sun: srgb(1, 0.95, 0.85),
    /** A cloud's sunlit top, and its thick grey middle. */
    cloud: srgb(0.98, 0.97, 0.95),
    cloudCore: srgb(0.66, 0.7, 0.77),
};

/**
 * A gradient by elevation, the horizon in the haze colour, the sun's disc and two
 * glows round it, and the clouds: the same cover the ground's shadows come from,
 * found where this ray meets the cloud layer. The disc is far past 1, so the
 * bloom finds it, unless a cloud is over it.
 */
function skyNode() {
    const dir = normalize(positionWorldDirection);
    const up = dir.y;
    const sky = mix(uniform(SKY.horizon), uniform(SKY.zenith), smoothstep(0.0, 0.5, up));
    const below = mix(uniform(SKY.horizon), uniform(SKY.below), smoothstep(0.0, -0.25, up));

    const reach = float(CLOUDS.height).sub(eye.y).div(max(up, 0.02));
    const cover = cloudCover(eye.xz.add(dir.xz.mul(reach)))
        .mul(smoothstep(0.02, 0.18, up))
        .toVar();
    const cloud = mix(uniform(SKY.cloud), uniform(SKY.cloudCore), smoothstep(0.5, 1, cover).mul(0.8));

    const toSun = max(dot(dir, uniform(SUN_DIRECTION)), 0);
    const disc = smoothstep(0.9994, 0.9997, toSun).mul(14).mul(cover.mul(0.95).oneMinus());
    const glow = pow(toSun, 60).mul(0.9).add(pow(toSun, 6).mul(0.18));
    const clouded = mix(sky, cloud.mul(glow.mul(0.6).add(1)), cover);
    return up
        .greaterThan(0)
        .select(clouded, below)
        .add(uniform(SKY.sun).mul(disc.add(glow.mul(cover.mul(0.5).oneMinus()))));
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
    camera.position.set(0, terrainHeight(0, 0) + EYE_HEIGHT, 0);
    const lookX = Math.cos(LOOK.angle) * LOOK.distance;
    const lookZ = Math.sin(LOOK.angle) * LOOK.distance;
    const target = new THREE.Vector3(lookX, terrainHeight(lookX, lookZ) + LOOK.height, lookZ);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.enablePan = false;
    // Stay in the field: never under it, never far above it.
    controls.minPolarAngle = 0.9;
    controls.maxPolarAngle = 1.62;
    controls.minDistance = 10;
    controls.maxDistance = 30;
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
        const dt = Math.min((now - last) / 1000, MAX_DT);
        elapsed += dt;
        last = now;
        controls.update();
        // Dragging round can swing the camera into a hill: keep it above the grass.
        const floor = terrainHeight(camera.position.x, camera.position.z) + MIN_CLEARANCE;
        if (camera.position.y < floor) camera.position.y = floor;
        updateField(elapsed, dt, camera);
        // The WebGL2 backend sorts on the CPU and only when asked; everything moves.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
