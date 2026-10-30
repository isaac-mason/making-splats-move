import { createRenderer, getGpuCaps, SplatCollection, SplatRenderer, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { glass, glassCentre, loadDiorama } from './globe';
import { initSnow } from './snow';
import './style.css';

const {
    dot,
    fract,
    max,
    mix,
    normalize,
    pass,
    positionWorldDirection,
    pow,
    screenCoordinate,
    screenUV,
    sin,
    smoothstep,
    vec2,
    vec3,
    vec4,
} = TSL;

const MAX_PIXEL_RATIO = 1.5;

const colour = (hex: string): TslNode => {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
};

const ROOM = { low: '#3a2f27', high: '#110d0b' };

function room(): TslNode {
    const up = normalize(positionWorldDirection).y;
    return mix(colour(ROOM.low), colour(ROOM.high), smoothstep(-0.3, 0.7, up));
}

const VIEW = { fov: 40, distance: 54, pitch: 0.5, turn: 0.42 };

const SHAKE = { jolt: [9, 14], stiffness: 90, damping: 0.35 };

const MAX_DT = 0.1;

const GRADE = { vignette: 0.45, dither: 1.5 };

function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): RenderPipeline {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);
    const color = pass(scene, camera).getTextureNode('output');
    const vignette = smoothstep(0.3, 1.0, screenUV.sub(0.5).length().mul(1.35)).mul(GRADE.vignette).oneMinus();
    const graded = max(color.rgb.mul(vignette), 0).toVar();
    const noise = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    const step = pow(graded.add(0.0005), vec3(1 - 1 / 2.2)).mul((2.2 / 255) * GRADE.dither);
    pipeline.outputNode = vec4(graded.add(step.mul(noise)), 1);
    return pipeline;
}

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = room();
    const camera = new THREE.PerspectiveCamera(VIEW.fov, window.innerWidth / window.innerHeight, 0.5, 2000);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const globe = new THREE.Group();
    globe.add(glass());
    const diorama = await loadDiorama(renderer);
    diorama.matrixWorld = () => globe.matrixWorld;
    const snow = await initSnow(renderer, getGpuCaps(renderer).compute);
    const splats = new SplatRenderer({ renderer, collection: new SplatCollection([diorama, snow.object]) });
    splats.raycast = () => {};
    scene.add(splats, globe);

    camera.position
        .set(Math.sin(VIEW.turn) * Math.cos(VIEW.pitch), Math.sin(VIEW.pitch), Math.cos(VIEW.turn) * Math.cos(VIEW.pitch))
        .multiplyScalar(VIEW.distance)
        .add(glassCentre);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(glassCentre);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 8;
    controls.maxDistance = 250;
    controls.update();

    const pipeline = initPost(renderer, scene, camera);

    const shake = { velocity: new THREE.Vector3(), accel: new THREE.Vector3() };
    window.addEventListener('keydown', (event) => {
        if (event.code !== 'Space') return;
        event.preventDefault();
        document.getElementById('hint')?.classList.add('hidden');
        const angle = Math.random() * Math.PI * 2;
        const speed = THREE.MathUtils.lerp(SHAKE.jolt[0], SHAKE.jolt[1], Math.random());
        shake.velocity.add(
            new THREE.Vector3(Math.cos(angle), (Math.random() - 0.5) * 0.6, Math.sin(angle)).multiplyScalar(speed),
        );
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const start = performance.now();
    let last = start;
    let frames = 0;
    renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;
        controls.update();

        const damping = 2 * Math.sqrt(SHAKE.stiffness) * SHAKE.damping;
        shake.accel.copy(globe.position).multiplyScalar(-SHAKE.stiffness).addScaledVector(shake.velocity, -damping);
        shake.velocity.addScaledVector(shake.accel, dt);
        globe.position.addScaledVector(shake.velocity, dt);
        globe.updateMatrixWorld();
        snow.update((now - start) / 1000, dt, globe.position, shake.accel);

        // The WebGL2 backend sorts on the CPU and only when asked.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
