import { createRenderer, SplatCollection, SplatRenderer, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshBasicNodeMaterial, RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { FLOOR, initConfetti } from './confetti';
import './style.css';

const {
    dot,
    fract,
    length,
    max,
    mix,
    normalize,
    pass,
    positionWorld,
    positionWorldDirection,
    pow,
    screenCoordinate,
    sin,
    smoothstep,
    vec2,
    vec3,
    vec4,
} = TSL;

/** Splats are fill-bound: past this, more pixels cost more than they show. */
const MAX_PIXEL_RATIO = 1.5;

const colour = (hex: string): TslNode => {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
};

/* the room */

const ROOM = { high: '#f7f1e9', low: '#e6d8c8', floor: '#efe6db', far: '#e6d8c8', melt: [6, 40] };

function backdrop(): TslNode {
    const up = normalize(positionWorldDirection).y;
    return mix(colour(ROOM.low), colour(ROOM.high), smoothstep(-0.1, 0.6, up));
}

function floor(): THREE.Mesh {
    const material = new MeshBasicNodeMaterial();
    const away = length(positionWorld.xz);
    material.colorNode = vec4(mix(colour(ROOM.floor), colour(ROOM.far), smoothstep(ROOM.melt[0], ROOM.melt[1], away)), 1);
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(200, 96).rotateX(-Math.PI / 2), material);
    mesh.position.y = FLOOR;
    return mesh;
}

/* the view */

/** Where you stand, and where you look: across the floor at about chest height. */
const VIEW = { fov: 50, eye: [0, 1.7, 6.5], target: [0, 1.4, 0] };

/** A click is a press and release moving less than this (pixels) within this (seconds). The muzzle is right of and below your eye (metres). */
const CLICK = { move: 6, time: 0.35, muzzle: [0.22, -0.2, 0.4], reach: 10 };

/** The dither that keeps the backdrop from banding, about a step of the 8-bit output. */
const DITHER = 1.5;

function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): RenderPipeline {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);
    const color = max(pass(scene, camera).getTextureNode('output').rgb, 0).toVar();
    const noise = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    const step = pow(color.add(0.0005), vec3(1 - 1 / 2.2)).mul((2.2 / 255) * DITHER);
    pipeline.outputNode = vec4(color.add(step.mul(noise)), 1);
    return pipeline;
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = backdrop();
    scene.add(floor());
    const camera = new THREE.PerspectiveCamera(VIEW.fov, window.innerWidth / window.innerHeight, 0.05, 1000);

    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const confetti = initConfetti();
    const splats = new SplatRenderer({ renderer });
    splats.collection = new SplatCollection([confetti.object]);
    scene.add(splats);

    camera.position.fromArray(VIEW.eye);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.fromArray(VIEW.target);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 1;
    controls.maxDistance = 60;
    // Never down through the floor.
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.update();

    const pipeline = initPost(renderer, scene, camera);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const muzzle = new THREE.Vector3();
    const towards = new THREE.Vector3();
    const fireAt = (x: number, y: number) => {
        pointer.set(x, y);
        raycaster.setFromCamera(pointer, camera);
        muzzle.set(CLICK.muzzle[0], CLICK.muzzle[1], -CLICK.muzzle[2]).applyMatrix4(camera.matrixWorld);
        towards.copy(raycaster.ray.at(CLICK.reach, towards)).sub(muzzle).normalize();
        confetti.fire(muzzle, towards);
    };
    let down: { x: number; y: number; at: number } | null = null;
    renderer.domElement.addEventListener('pointerdown', (event) => {
        down = { x: event.clientX, y: event.clientY, at: performance.now() };
    });
    renderer.domElement.addEventListener('pointerup', (event) => {
        if (!down) return;
        const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
        const quick = (performance.now() - down.at) / 1000 < CLICK.time;
        down = null;
        if (moved > CLICK.move || !quick || event.button !== 0) return;
        fireAt((event.clientX / window.innerWidth) * 2 - 1, 1 - (event.clientY / window.innerHeight) * 2);
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const start = performance.now();
    let frames = 0;
    let opened = false;
    renderer.setAnimationLoop(() => {
        controls.update();
        const elapsed = (performance.now() - start) / 1000;
        confetti.update(elapsed, camera.position);
        // One burst to open with, once there's something to see.
        if (!opened && elapsed > 0.6) {
            opened = true;
            fireAt(0, 0.1);
        }
        // The WebGL2 backend sorts on the CPU and only when asked; everything moves.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
