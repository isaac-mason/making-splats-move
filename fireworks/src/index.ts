import { createRenderer, SplatCollection, SplatRenderer, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { initShow, SCHEDULE, shellOf } from './fireworks';
import './style.css';

const {
    atan,
    dot,
    exp,
    floor,
    fract,
    length,
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
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

const MAX_PIXEL_RATIO = 1.5;

const colour = (hex: string): TslNode => {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
};

/* the night */

const NIGHT = { horizon: '#1b2240', zenith: '#03050b', hills: '#020305' };

const HILLS = { base: 0.035, bumps: [0.018, 0.011, 0.006], every: [2, 5, 11] };

const STARS = { cells: 260, share: 0.004, size: 0.22, bright: 0.5, from: [0.1, 0.5] };

const cellHash = (cell: TslNode, k: number): TslNode =>
    fract(sin(dot(cell, vec3(12.9898 + k, 78.233, 37.719 - k))).mul(43758.5453));

const GLOW = { flash: 1, burn: 0.35, tight: 30, halo: 0.05, lift: 0.006, crest: 0.6 };

const skyTime = uniform(0);

function showLight(dir: TslNode): TslNode {
    const eye = vec3(VIEW.eye[0], VIEW.eye[1], VIEW.eye[2]);
    let light: TslNode = vec3(0);
    for (let i = 0; i < SCHEDULE.slots; i++) {
        const shell = shellOf(uint(i), skyTime);
        const strength = exp(shell.after.mul(-3))
            .mul(GLOW.flash)
            .add(exp(shell.after.mul(-0.7)).mul(GLOW.burn));
        const halo = pow(max(dot(dir, normalize(shell.burst.sub(eye))), 0), GLOW.tight);
        const lit = shell.main.mul(strength).mul(halo.mul(GLOW.halo).add(GLOW.lift));
        light = light.add(shell.fired.and(shell.after.greaterThan(0)).select(lit, vec3(0)));
    }
    return light;
}

function skyNode(): TslNode {
    const dir = normalize(positionWorldDirection).toVar();
    const light = showLight(dir).toVar();
    const up = max(dir.y, 0);
    const sky = mix(colour(NIGHT.horizon), colour(NIGHT.zenith), smoothstep(0, 0.5, up));

    const grid = dir.mul(STARS.cells);
    const cell = floor(grid);
    const lit = cellHash(cell, 0).greaterThan(1 - STARS.share);
    const point = smoothstep(STARS.size, 0, length(fract(grid).sub(0.5)));
    const star = lit
        .select(point, 0)
        .mul(cellHash(cell, 1).mul(0.8).add(0.2))
        .mul(smoothstep(STARS.from[0], STARS.from[1], up))
        .mul(STARS.bright);

    const around = atan(dir.z, dir.x);
    const ridge = HILLS.bumps.reduce<TslNode>(
        (line, size, i) => line.add(sin(around.mul(HILLS.every[i]).add(i * 1.7)).mul(size)),
        TSL.float(HILLS.base),
    );
    const crest = smoothstep(ridge.sub(0.02), ridge, dir.y).mul(GLOW.crest);
    return dir.y.lessThan(ridge).select(colour(NIGHT.hills).add(light.mul(crest)), sky.add(vec3(star)).add(light));
}

/* the view */

const VIEW = { fov: 55, eye: [0, 2, 0] };

/* post */

const BLOOM = { strength: 0.15, radius: 0.3, threshold: 1.2 };
const GRADE = { vignette: 0.3, dither: 1.5 };

function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): RenderPipeline {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);
    const color = pass(scene, camera).getTextureNode('output');
    const glow = bloom(color, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    const vignette = smoothstep(0.35, 1.0, screenUV.sub(0.5).length().mul(1.35)).mul(GRADE.vignette).oneMinus();
    const graded = max(color.add(glow).rgb.mul(vignette), 0).toVar();
    const noise = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    const step = pow(graded.add(0.0005), vec3(1 - 1 / 2.2)).mul((2.2 / 255) * GRADE.dither);
    pipeline.outputNode = vec4(graded.add(step.mul(noise)), 1);
    return pipeline;
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = skyNode();
    const camera = new THREE.PerspectiveCamera(VIEW.fov, window.innerWidth / window.innerHeight, 0.1, 5000);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const show = initShow();
    const splats = new SplatRenderer({ renderer });
    splats.collection = new SplatCollection([show.object]);
    scene.add(splats);

    camera.position.fromArray(VIEW.eye);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(show.centre);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 5;
    controls.maxDistance = 1000;
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
        const elapsed = (performance.now() - start) / 1000;
        show.update(elapsed);
        skyTime.value = elapsed;
        // The WebGL2 backend sorts on the CPU and only when asked; everything moves.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
