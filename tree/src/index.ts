import { createRenderer, getGpuCaps, SplatCollection, SplatRenderer, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { initTree, SUN_DIRECTION, updateTrees } from './tree';
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

const SKY = { horizon: '#cfe7f3', zenith: '#3a78d6' };

function skyNode(): TslNode {
    const up = max(normalize(positionWorldDirection).y, 0);
    return mix(colour(SKY.horizon), colour(SKY.zenith), smoothstep(0, 0.8, up));
}

const TREE = { seed: 7, at: new THREE.Vector3(0, 0, 0), size: 1 };

const VIEW = { fov: 50, distance: 17, height: 1.7, angle: Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x) + 1.4 };

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

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = skyNode();
    const camera = new THREE.PerspectiveCamera(VIEW.fov, window.innerWidth / window.innerHeight, 0.1, 5000);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const tree = initTree(renderer, getGpuCaps(renderer).compute, TREE);
    const splats = new SplatRenderer({ renderer });
    splats.collection = new SplatCollection(tree.objects);
    scene.add(splats);

    camera.position.set(Math.cos(VIEW.angle) * VIEW.distance, VIEW.height, Math.sin(VIEW.angle) * VIEW.distance);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(tree.centre);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 2;
    controls.maxDistance = 400;
    controls.update();

    const pipeline = initPost(renderer, scene, camera);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const start = performance.now();
    let frames = 0;
    renderer.setAnimationLoop(() => {
        controls.update();
        updateTrees((performance.now() - start) / 1000);
        // The WebGL2 backend sorts on the CPU and only when asked.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
