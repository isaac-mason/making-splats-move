import { createRenderer, SplatCollection, SplatRenderer, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { type Daylight, daylightAt, hoursPerSecond } from './daylight';
import { loadRelit, tone } from './relight';
import './style.css';

const {
    Fn,
    dot,
    float,
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
    step,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

const MAX_DT = 0.1;
const MAX_PIXEL_RATIO = 1.5;

const START_HOUR = 16.4;

const VIEW = { position: [10.63, 3.8, -13.23], target: [0, 1.7, -4.4], fov: 55 };

/* the sky */

const sky = {
    zenith: uniform(new THREE.Vector3()),
    horizon: uniform(new THREE.Vector3()),
    sun: uniform(new THREE.Vector3(0, 1, 0)),
    sunColour: uniform(new THREE.Vector3()),
    moon: uniform(new THREE.Vector3(0, 1, 0)),
    night: uniform(0),
    exposure: uniform(1),
    time: uniform(0),
};

const STARS = { density: 260, share: 0.02, size: 0.16, colour: [0.85, 0.9, 1.0], brightness: 0.9 };
const MOON = { disc: 0.99994, colour: [0.9, 0.93, 1.0], brightness: 1.2, halo: 0.06 };

const skyNode = Fn((): TslNode => {
    const dir = normalize(positionWorldDirection).toVar();
    const up = dir.y;
    const above = mix(sky.horizon, sky.zenith, pow(smoothstep(0, 1, max(up, 0)), 0.5));
    const below = mix(sky.horizon, sky.horizon.mul(0.55), smoothstep(0, -0.25, up));
    const colour = mix(below, above, step(0, up)).toVar();

    const toSun = max(dot(dir, sky.sun), 0).toVar();
    colour.addAssign(sky.horizon.mul(pow(toSun, 6).mul(0.8)).mul(sky.night.oneMinus()));
    const disc = smoothstep(0.9998, 0.99988, toSun).mul(15).mul(step(0, up));
    colour.addAssign(sky.sunColour.mul(pow(toSun, 300).mul(1.2).add(pow(toSun, 20).mul(0.15)).add(disc)));

    const g = dir.mul(STARS.density);
    const cell = floor(g);
    const h = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
    const k = fract(sin(dot(cell, vec3(269.5, 183.3, 246.1))).mul(43758.5453));
    const centre = cell.add(0.5).add(
        vec3(h, k, fract(h.add(k).mul(7.13)))
            .sub(0.5)
            .mul(0.6),
    );
    const star = smoothstep(STARS.size, 0, length(g.sub(centre)))
        .mul(step(1 - STARS.share, h))
        .mul(
            sin(sky.time.mul(2.3).add(k.mul(60)))
                .mul(0.3)
                .add(0.7),
        )
        .mul(k.mul(0.7).add(0.3));
    const night = sky.night.mul(smoothstep(0.02, 0.2, up));
    colour.addAssign(vec3(...STARS.colour).mul(star.mul(night).mul(STARS.brightness)));

    const toMoon = max(dot(dir, sky.moon), 0);
    const moon = smoothstep(MOON.disc - 0.00004, MOON.disc, toMoon)
        .mul(MOON.brightness)
        .add(pow(toMoon, 80).mul(MOON.halo));
    colour.addAssign(vec3(...MOON.colour).mul(moon.mul(night)));

    return tone(colour.mul(sky.exposure));
});

function setSky(day: Daylight, time: number): void {
    sky.zenith.value.set(...day.zenith);
    sky.horizon.value.set(...day.horizon);
    sky.sun.value.set(...day.sun);
    sky.sunColour.value.set(...day.sunColour);
    sky.moon.value.set(...day.moon);
    sky.night.value = day.night;
    sky.exposure.value = day.exposure;
    sky.time.value = time;
}

/* post */

const BLOOM = { strength: 0.25, radius: 0.5, threshold: 0.97 };
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
    pipeline.outputNode = vec4(graded.add(step.mul(noise)), float(1));
    return pipeline;
}

/* the clock */

function initClock(start: number) {
    const play = document.querySelector<HTMLButtonElement>('#play') as HTMLButtonElement;
    const slider = document.querySelector<HTMLInputElement>('#hour') as HTMLInputElement;
    const label = document.querySelector<HTMLSpanElement>('#time') as HTMLSpanElement;
    const clock = { hour: start, playing: true, scrubbing: false };
    let shown = '';

    const setPlaying = (playing: boolean) => {
        clock.playing = playing;
        play.classList.toggle('paused', !playing);
        play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    };
    play.addEventListener('click', () => setPlaying(!clock.playing));
    window.addEventListener('keydown', (event) => {
        if (event.code !== 'Space') return;
        event.preventDefault();
        setPlaying(!clock.playing);
    });
    slider.addEventListener('input', () => {
        clock.hour = Number(slider.value);
    });
    slider.addEventListener('pointerdown', () => {
        clock.scrubbing = true;
    });
    window.addEventListener('pointerup', () => {
        clock.scrubbing = false;
    });

    return {
        clock,
        advance(dt: number, elevation: number) {
            if (clock.playing && !clock.scrubbing) clock.hour = (clock.hour + hoursPerSecond(elevation) * dt) % 24;
            const minutes = Math.floor(clock.hour * 60) % (24 * 60);
            const text = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
            if (text !== shown) {
                shown = text;
                label.textContent = text;
                if (!clock.scrubbing) slider.value = String(clock.hour);
            }
        },
    };
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = skyNode();
    const camera = new THREE.PerspectiveCamera(VIEW.fov, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(VIEW.position[0], VIEW.position[1], VIEW.position[2]);

    // MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const relit = await loadRelit(renderer);
    console.log(`time: ${relit.count.toLocaleString()} splats`);
    const splats = new SplatRenderer({ renderer, collection: new SplatCollection([relit.object]) });
    splats.raycast = () => {};
    scene.add(splats);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(VIEW.target[0], VIEW.target[1], VIEW.target[2]);
    controls.enableDamping = true;
    controls.minDistance = 3;
    controls.maxDistance = 40;
    // Not under the lawn.
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.update();

    const pipeline = initPost(renderer, scene, camera);
    const { clock, advance } = initClock(START_HOUR);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const begun = performance.now();
    let last = begun;
    let frames = 0;
    let elevation = daylightAt(clock.hour).elevation;
    renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;
        controls.update();

        advance(dt, elevation);
        const day = daylightAt(clock.hour);
        elevation = day.elevation;
        relit.update(day);
        setSky(day, (now - begun) / 1000);

        pipeline.render();
        // Past the first frames' shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
