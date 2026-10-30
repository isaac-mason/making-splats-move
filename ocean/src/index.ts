/**
 * An open ocean, nothing captured: a fresh breeze's sea under a clear sky, one
 * smooth surface shaded per pixel (sea.ts), and a little sailboat of splats to
 * sail on it (boat.ts), seen from behind and above. W/S to sail and slow, A/D to
 * steer, drag to look round, scroll to come closer. Backtick hides the splat
 * count.
 *
 * Drawn by Radix on three's WebGPURenderer: WebGPU where there is one, its
 * WebGL2 backend elsewhere (or with `?gpu=webgpu-gl`); nothing here needs
 * compute, so both draw the same sea.
 */

import { createRenderer, SplatCollection, SplatRenderer, TSL } from '@sparkjsdev/radix';
import * as THREE from 'three';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { initBoat } from './boat';
import { initSea, skyColour } from './sea';
import { initWake } from './wake';
import { initWaves } from './waves';
import { initWind } from './wind';
import './style.css';

const {
    dot,
    float,
    fract,
    max,
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

/** Splats are fill-bound: past this, more pixels cost more than they show. */
const MAX_PIXEL_RATIO = 1.5;

/* the view */

/**
 * The camera: behind the boat and above it, looking at a point this high over
 * its deck. How far back (metres, and how close and far you can scroll), how far
 * up (radians above level, and the range you can drag), how quickly it swings
 * round behind the boat as it sails, and how quickly a drag turns it.
 */
const CHASE = {
    fov: 55,
    at: 1.3,
    distance: 9,
    near: 4.5,
    far: 22,
    rise: 0.3,
    lowest: 0.06,
    highest: 1.2,
    swing: 1.2,
    drag: 0.005,
};

/* post */

/** A darkening at the corners, and the dither that keeps the smooth sky from banding. No bloom. */
const GRADE = { vignette: 0.18, dither: 1.5 };

/** Splats blend sRGB-encoded but land in the pass decoded to linear: encode back, no tone mapping. */
function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): RenderPipeline {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);
    const color = pass(scene, camera).getTextureNode('output');
    const vignette = smoothstep(0.35, 1.0, screenUV.sub(0.5).length().mul(1.35)).mul(GRADE.vignette).oneMinus();
    const graded = max(color.rgb.mul(vignette), 0).toVar();
    const noise = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    const step = pow(graded.add(0.0005), vec3(1 - 1 / 2.2)).mul((2.2 / 255) * GRADE.dither);
    pipeline.outputNode = vec4(graded.add(step.mul(noise)), float(1));
    return pipeline;
}

/* the splat count */

/** A little readout in the corner: how many splats, of what, and the frame rate. Backtick hides it. */
function initCounter() {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'padding:6px 8px',
        'font:12px/1.45 monospace',
        'white-space:pre',
        'color:#eaf7ff',
        'background:rgba(10,40,90,0.45)',
        'border-radius:4px',
        'pointer-events:none',
        'z-index:1000',
    ].join(';');
    document.body.append(element);
    window.addEventListener('keydown', (event) => {
        if (event.key === '`') element.style.display = element.style.display === 'none' ? '' : 'none';
    });
    let shown = 0;
    let frames = 0;
    const fmt = (n: number) => n.toLocaleString('en-US').padStart(9);
    return (now: number, counts: Record<string, number>) => {
        frames++;
        if (now - shown < 500) return;
        const fps = (frames * 1000) / (now - shown);
        shown = now;
        frames = 0;
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        element.textContent = [
            `splats ${fmt(total)}`,
            ...Object.entries(counts).map(([name, n]) => `  ${name.padEnd(5)}${fmt(n)}`),
            `fps    ${fps.toFixed(0).padStart(9)}`,
        ].join('\n');
    };
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = skyColour(normalize(positionWorldDirection), true);
    const camera = new THREE.PerspectiveCamera(CHASE.fov, window.innerWidth / window.innerHeight, 0.1, 5000);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    // The wake's simulated in compute: WebGPU only.
    const wake = initWake(renderer, Boolean((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend));
    const waves = initWaves(renderer);
    const sea = initSea(wake, waves);
    const boat = initBoat(renderer);
    const splats = new SplatRenderer({ renderer });
    const wind = initWind();
    splats.collection = new SplatCollection([...sea.objects, boat.object, wind.object]);
    scene.add(splats);

    const pipeline = initPost(renderer, scene, camera);
    const count = initCounter();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // The chase camera: a yaw and a rise round the boat, dragged by hand and swinging back
    // behind it as it sails.
    let yaw = 0;
    let rise = CHASE.rise;
    let distance = CHASE.distance;
    let dragging = false;
    renderer.domElement.addEventListener('pointerdown', (event) => {
        dragging = true;
        renderer.domElement.setPointerCapture(event.pointerId);
    });
    renderer.domElement.addEventListener('pointerup', () => {
        dragging = false;
    });
    renderer.domElement.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        // Like grabbing the world and turning it: drag right and the view swings round to the left.
        yaw += event.movementX * CHASE.drag;
        rise = THREE.MathUtils.clamp(rise + event.movementY * CHASE.drag, CHASE.lowest, CHASE.highest);
    });
    renderer.domElement.addEventListener(
        'wheel',
        (event) => {
            event.preventDefault();
            distance = THREE.MathUtils.clamp(distance * Math.exp(event.deltaY * 0.001), CHASE.near, CHASE.far);
        },
        { passive: false },
    );
    const look = new THREE.Vector3();

    const start = performance.now();
    let before = start;
    let frames = 0;
    renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - before) / 1000, 0.1);
        before = now;
        const elapsed = (now - start) / 1000;

        // The sea first, then the boat on it: it feels the water at its bow, stern and sides,
        // and the camera's spot too, read back from the GPU a frame or two late.
        waves.update(elapsed);
        const felt = waves.probe([...boat.feels(), [camera.position.x, camera.position.z]]);
        boat.update(dt, felt);
        const heading = boat.heading();
        sea.boatAt(boat.holder.position.x, boat.holder.position.z, heading);
        wake.step(dt, boat.holder.position.x, boat.holder.position.z, heading);

        // Swing round behind the boat while it's under way, the short way round.
        if (!dragging && Math.abs(boat.speed()) > 0.5) {
            const behind = Math.atan2(Math.sin(heading - yaw), Math.cos(heading - yaw));
            yaw += behind * (1 - Math.exp(-CHASE.swing * dt));
        }
        look.copy(boat.holder.position).add(new THREE.Vector3(0, CHASE.at, 0));
        camera.position.set(
            look.x - Math.sin(yaw) * Math.cos(rise) * distance,
            look.y + Math.sin(rise) * distance,
            look.z + Math.cos(yaw) * Math.cos(rise) * distance,
        );
        // Never under the water.
        camera.position.y = Math.max(camera.position.y, (felt[5] ?? 0) + 0.8);
        camera.lookAt(look);

        sea.update(elapsed, camera.position);
        wind.update(elapsed, camera.position);
        // The WebGL2 backend sorts on the CPU and only when asked; everything moves.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        count(now, { water: sea.count(camera.position), boat: boat.count, wind: wind.count });
        // A few frames in, past the first frame's shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
