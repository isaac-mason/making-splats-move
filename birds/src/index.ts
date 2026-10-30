import { createRenderer, getGpuCaps, SplatCollection, SplatRenderer, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { initBirds, SUN_DIRECTION } from './flock';
import './style.css';

const {
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
    vec2,
    vec3,
    vec4,
} = TSL;

const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);

/** So a stall or a tab switch can't jump the flock forward. */
const MAX_DT = 0.1;
/** Splats are fill-bound: past this, more pixels cost more than they show. */
const MAX_PIXEL_RATIO = 1.5;

/* the dusk */

const SKY = {
    zenith: [0.025, 0.04, 0.12],
    middle: [0.12, 0.12, 0.28],
    pink: [0.4, 0.22, 0.27],
    glow: [1.15, 0.42, 0.12],
    band: 0.11,
    bloom: { power: 10, amount: 0.5 },
};

const STARS = { cells: 260, share: 0.004, size: 0.22, bright: 0.45, from: [0.35, 0.9] };

const cellHash = (cell: TslNode, k: number): TslNode =>
    fract(sin(dot(cell, vec3(12.9898 + k, 78.233, 37.719 - k))).mul(43758.5453));

function skyNode(): TslNode {
    const dir = normalize(positionWorldDirection).toVar();
    const up = max(dir.y, 0);
    const sun = v3([SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z]);
    const level = normalize(vec3(dir.x, 0, dir.z).add(vec3(1e-5, 0, 0)));
    const toward = max(dot(level, normalize(vec3(sun.x, 0, sun.z))), 0);
    const horizon = mix(v3(SKY.pink), v3(SKY.glow), pow(toward, 3));
    const band = exp(up.div(-SKY.band));
    const low = mix(v3(SKY.middle), horizon, band);
    const sky = mix(low, v3(SKY.zenith), smoothstep(0.15, 0.85, up));
    const bloom = pow(max(dot(dir, sun), 0), SKY.bloom.power).mul(SKY.bloom.amount);

    const grid = dir.mul(STARS.cells);
    const cell = floor(grid);
    const lit = cellHash(cell, 0).greaterThan(1 - STARS.share);
    const point = smoothstep(STARS.size, 0, length(fract(grid).sub(0.5)));
    const star = lit
        .select(point, 0)
        .mul(cellHash(cell, 1).mul(0.8).add(0.2))
        .mul(smoothstep(STARS.from[0], STARS.from[1], up))
        .mul(STARS.bright);

    return sky.add(v3(SKY.glow).mul(bloom)).add(vec3(star));
}

/* the view */

const WATCH = { fov: 62, follow: 1.2, minPitch: 0.55, maxPitch: 1.35 };

/** After you let go, seconds before you're brought back, and seconds to ease back. */
const HANDOFF = { idle: 5, ease: 4 };

/* post */

const GRADE = { vignette: 0.35, dither: 1.5 };

/** Splats blend sRGB-encoded but reach the pass as linear: encode back, no tone mapping. */
function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): RenderPipeline {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);
    const color = pass(scene, camera).getTextureNode('output');
    const vignette = smoothstep(0.35, 1.0, screenUV.sub(0.5).length().mul(1.35)).mul(GRADE.vignette).oneMinus();
    const graded = max(color.rgb.mul(vignette), 0).toVar();
    const noise = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    const step = pow(graded.add(0.0005), vec3(1 - 1 / 2.2)).mul((2.2 / 255) * GRADE.dither);
    pipeline.outputNode = vec4(graded.add(step.mul(noise)), 1);
    return pipeline;
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = skyNode();

    const camera = new THREE.PerspectiveCamera(WATCH.fov, window.innerWidth / window.innerHeight, 0.1, 5000);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const birds = initBirds(renderer, getGpuCaps(renderer).compute);
    const splats = new SplatRenderer({ renderer });
    splats.collection = new SplatCollection([birds.object]);
    scene.add(splats);

    const eye = new THREE.Vector3();
    const watched = birds.roost.clone();
    const watch = { position: eye.clone(), quaternion: new THREE.Quaternion() };
    const aim = new THREE.Vector3();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const turnTo = (target: THREE.Vector3) => {
        aim.copy(target).sub(eye);
        const yaw = Math.atan2(-aim.x, -aim.z);
        const pitch = THREE.MathUtils.clamp(Math.atan2(aim.y, Math.hypot(aim.x, aim.z)), WATCH.minPitch, WATCH.maxPitch);
        watch.quaternion.setFromEuler(euler.set(pitch, yaw, 0));
    };
    turnTo(watched);
    camera.position.copy(eye);
    camera.quaternion.copy(watch.quaternion);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 2;
    controls.maxDistance = 2000;
    let mode: 'watch' | 'user' | 'return' = 'watch';
    let holding = false;
    let letGo = 0;
    let elapsed = 0;
    let returning = 0;
    const from = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    controls.addEventListener('start', () => {
        if (mode !== 'user') controls.target.copy(birds.roost);
        mode = 'user';
        holding = true;
    });
    controls.addEventListener('end', () => {
        holding = false;
        letGo = elapsed;
    });

    const pipeline = initPost(renderer, scene, camera);

    const pointer = new THREE.Vector2();
    let pointing = false;
    const raycaster = new THREE.Raycaster();
    renderer.domElement.addEventListener('pointermove', (event) => {
        pointer.set((event.clientX / window.innerWidth) * 2 - 1, 1 - (event.clientY / window.innerHeight) * 2);
        pointing = true;
    });
    renderer.domElement.addEventListener('pointerleave', () => {
        pointing = false;
    });

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
        elapsed += dt;
        last = now;

        if (pointing) raycaster.setFromCamera(pointer, camera);
        birds.update(elapsed, dt, camera.position, pointing ? raycaster.ray : null);
        watched.lerp(birds.roost, 1 - Math.exp(-dt / WATCH.follow));
        turnTo(watched);

        if (mode === 'user') {
            controls.update();
            if (!holding && elapsed - letGo > HANDOFF.idle) {
                mode = 'return';
                returning = 0;
                from.position.copy(camera.position);
                from.quaternion.copy(camera.quaternion);
            }
        } else {
            if (mode === 'return') returning += dt;
            const k = mode === 'return' ? THREE.MathUtils.smoothstep(returning, 0, HANDOFF.ease) : 1;
            camera.position.lerpVectors(from.position, watch.position, k);
            camera.quaternion.slerpQuaternions(from.quaternion, watch.quaternion, k);
            if (k >= 1) mode = 'watch';
        }

        // The WebGL2 backend sorts on the CPU and only when asked; everything moves.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
