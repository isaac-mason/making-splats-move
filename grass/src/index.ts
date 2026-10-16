/**
 * Rolling hills of grass on a summer afternoon that go on for ever, every splat of
 * it procedural (field.ts): wind combs the grass, flowers and butterflies, cloud
 * shadows sweep the hills, and you walk through it all, trampling a path. The far
 * field fades into a haze that is also the sky's horizon.
 *
 * Drawn by spark-radix on three's WebGPURenderer: WebGPU where there is one, its
 * WebGL2 backend elsewhere (or with `?gpu=webgpu-gl`). WASD to walk, shift to run,
 * drag to look round.
 */

import { createRenderer, SplatCollection, SplatRenderer, TSL } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import cloudUrl from '../assets/cloud.jpg?url';
import { HAZE, initField, SUN_DIRECTION, terrainHeight, updateField, type Walker } from './field';
import './style.css';

const { dot, max, mix, normalize, pass, positionWorldDirection, pow, screenUV, smoothstep, uniform, vec4 } = TSL;

/* walking */

/**
 * You walk the meadow in third person: WASD (or the arrows) relative to where the
 * camera looks, shift to run. The camera follows behind; drag to look round you,
 * scroll to come closer or stand back. The meadow is centred on you and never
 * ends, so you can run as far and as fast as you like.
 */
const WALK = {
    /** Walking and running speed, m/s, and how quickly you get up to speed. */
    speed: 2.6,
    run: 9,
    grip: 8,
    /** A step's length walking, and a skip's running, metres: the stride clock. */
    stride: 0.9,
    skip: 3.2,
    /** How quickly you turn to face the way you're going. */
    turn: 10,
    /**
     * How far round from behind the kid the camera may go, radians each way: never
     * round to the face. It follows the kid's facing.
     */
    behind: 1.45,
    /** Which way you face at the start, radians in xz: up the long rise to the crest. */
    facing: (140 * Math.PI) / 180,
    /** The camera: how far back and above to start, and how close to the grass it may get. */
    back: 4,
    above: 1.4,
    clearance: 0.6,
    /** What the camera looks at: you, at about chest height. */
    chest: 1.0,
};

const KEYS: Record<string, [number, number]> = {
    KeyW: [0, 1],
    ArrowUp: [0, 1],
    KeyS: [0, -1],
    ArrowDown: [0, -1],
    KeyA: [-1, 0],
    ArrowLeft: [-1, 0],
    KeyD: [1, 0],
    ArrowRight: [1, 0],
};

function initKeys() {
    const held = new Set<string>();
    window.addEventListener('keydown', (event) => held.add(event.code));
    window.addEventListener('keyup', (event) => held.delete(event.code));
    window.addEventListener('blur', () => held.clear());
    return held;
}

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const wanted = new THREE.Vector3();
const before = new THREE.Vector3();

/**
 * `?kid=1`: just the kid on the ground, walking and skipping round a circle on its
 * own (walk, skip, stand, again), so the dress and hair can be looked at closely
 * and cheaply. Drag to look round; the camera follows.
 */
const PREVIEW = new URLSearchParams(location.search).has('kid');

/** Where the preview kid wants to go: round a circle, walking, then skipping, then standing. */
function previewSteer(elapsed: number, walker: Walker, out: THREE.Vector3): THREE.Vector3 {
    const phase = elapsed % 15;
    const speed = phase < 6 ? WALK.speed : phase < 12 ? WALK.run * 0.6 : 0;
    const angle = Math.atan2(walker.position.z, walker.position.x) + 0.6;
    const radius = 3;
    // Towards a point a little way round the circle.
    out.set(Math.cos(angle) * radius - walker.position.x, 0, Math.sin(angle) * radius - walker.position.z);
    return out.lengthSq() > 0 ? out.normalize().multiplyScalar(speed) : out;
}

/** Moves you a step by the keys held (or `steer`, a velocity), along the ground, and the camera with you. */
function walk(
    walker: Walker,
    held: Set<string>,
    camera: THREE.Camera,
    controls: OrbitControls,
    dt: number,
    steer?: THREE.Vector3,
) {
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, camera.up).normalize();

    wanted.set(0, 0, 0);
    for (const code of held) {
        const step = KEYS[code];
        if (step) wanted.addScaledVector(right, step[0]).addScaledVector(forward, step[1]);
    }
    const running = held.has('ShiftLeft') || held.has('ShiftRight');
    if (wanted.lengthSq() > 0) wanted.normalize().multiplyScalar(running ? WALK.run : WALK.speed);
    if (steer) wanted.copy(steer);
    walker.velocity.lerp(wanted, 1 - Math.exp(-WALK.grip * dt));

    before.copy(walker.position);
    walker.position.addScaledVector(walker.velocity, dt);
    walker.position.y = terrainHeight(walker.position.x, walker.position.z);
    // Faster than a walk is skipping; turn to face the way you're going.
    const speed = Math.hypot(walker.velocity.x, walker.velocity.z);
    const skipping = THREE.MathUtils.clamp((speed - WALK.speed) / (WALK.run - WALK.speed), 0, 1);
    walker.skipping += (skipping - walker.skipping) * (1 - Math.exp(-6 * dt));
    walker.stride += (speed * dt) / THREE.MathUtils.lerp(WALK.stride, WALK.skip, walker.skipping);
    // Turn to face the way you're going, unless that's back towards the camera:
    // then back-pedal, or the kid would turn to face the camera, the camera would
    // swing round behind, and round and round.
    const backing = wanted.lengthSq() > 0 && wanted.dot(forward) < -0.3 * wanted.length();
    if (speed > 0.2 && !backing) {
        const toward = Math.atan2(walker.velocity.x, walker.velocity.z);
        const turn = Math.atan2(Math.sin(toward - walker.facing), Math.cos(toward - walker.facing));
        walker.facing += turn * (1 - Math.exp(-WALK.turn * dt));
    }

    // The camera comes along, keeping its place behind you.
    before.subVectors(walker.position, before);
    camera.position.add(before);
    controls.target.copy(walker.position).y += WALK.chest;
    // And only ever behind: never round to the face.
    const behindYou = walker.facing + Math.PI;
    controls.minAzimuthAngle = behindYou - WALK.behind;
    controls.maxAzimuthAngle = behindYou + WALK.behind;
}

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
};

/**
 * A gradient by elevation, the horizon in the haze colour, and the sun's disc and
 * two glows round it. The disc is far past 1, so the bloom finds it. The clouds
 * aren't drawn: they're only ever seen as their shadows on the grass.
 */
function skyNode() {
    const dir = normalize(positionWorldDirection);
    const up = dir.y;
    const sky = mix(uniform(SKY.horizon), uniform(SKY.zenith), smoothstep(0.0, 0.5, up));
    const below = mix(uniform(SKY.horizon), uniform(SKY.below), smoothstep(0.0, -0.25, up));
    const toSun = max(dot(dir, uniform(SUN_DIRECTION)), 0);
    const disc = smoothstep(0.9994, 0.9997, toSun).mul(14);
    const glow = pow(toSun, 60).mul(0.9).add(pow(toSun, 6).mul(0.18));
    return up
        .greaterThan(0)
        .select(sky, below)
        .add(uniform(SKY.sun).mul(disc.add(glow)));
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
    const walker: Walker = {
        position: new THREE.Vector3(0, terrainHeight(0, 0), 0),
        velocity: new THREE.Vector3(),
        stride: 0,
        facing: Math.atan2(Math.cos(WALK.facing), Math.sin(WALK.facing)),
        skipping: 0,
    };
    const target = walker.position.clone();
    target.y += WALK.chest;
    camera.position.set(-Math.cos(WALK.facing), 0, -Math.sin(WALK.facing)).multiplyScalar(WALK.back).add(target);
    camera.position.y += WALK.above;
    const held = initKeys();

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    // The camera's tied to you, so no panning away.
    controls.enablePan = false;
    // Never under the grass, never straight down on you.
    controls.minPolarAngle = 0.5;
    controls.maxPolarAngle = 1.6;
    controls.minDistance = 2.5;
    controls.maxDistance = 14;
    controls.update();

    const field = initField(renderer, await new THREE.TextureLoader().loadAsync(cloudUrl), PREVIEW);
    const splats = new SplatRenderer({ renderer });
    splats.collection = new SplatCollection(field.objects);
    scene.add(splats);

    const pipeline = initPost(renderer, scene, camera);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const steering = new THREE.Vector3();
    let last = performance.now();
    let elapsed = 0;
    let frames = 0;
    renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, MAX_DT);
        elapsed += dt;
        last = now;
        walk(walker, held, camera, controls, dt, PREVIEW ? previewSteer(elapsed, walker, steering) : undefined);
        controls.update();
        // Looking round can swing the camera into a hill: keep it above the grass.
        const floor = terrainHeight(camera.position.x, camera.position.z) + WALK.clearance;
        if (camera.position.y < floor) camera.position.y = floor;
        updateField(elapsed, dt, camera, walker);
        // The WebGL2 backend sorts on the CPU and only when asked; everything moves.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
        // The hint goes once you've set off.
        if (walker.velocity.lengthSq() > 1) document.getElementById('hint')?.classList.add('hidden');
    });
}

start();
