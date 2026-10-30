import { createRenderer, SplatCollection, SplatRenderer, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { cloudShadow, hazeToward, initClouds, LIGHT, SUN_DIRECTION, updateClouds } from './clouds';
import './style.css';

const {
    cameraPosition,
    dot,
    exp,
    float,
    int,
    length,
    max,
    mix,
    mx_noise_float,
    normalize,
    pass,
    positionWorldDirection,
    pow,
    screenUV,
    smoothstep,
    uniform,
    uv,
    vec2,
    vec3,
    vec4,
} = TSL;

const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);

const MAX_DT = 0.1;
const MAX_PIXEL_RATIO = 1.5;

/* the take */

const SUN_HEADING = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x);

const GLIDE = {
    /** Metres a second: a cell of the field every ten seconds. Faster, and bases this near whip past. */
    speed: 17,
    /** The heading's offset from the sun's, radians, and its weave: radians and seconds round. */
    offset: 0.42,
    weave: [
        { amount: 0.3, period: 110, phase: 0 },
        { amount: 0.12, period: 47, phase: 1 },
    ],
    /** Altitude, metres: the middle, how far either side, and seconds round. The bases are at 150. */
    // Keeps the nearest bases 90 m+ away; nearer, their splats blur on screen.
    altitude: { middle: 50, swing: 10, period: 70 },
    pitch: 0.36,
    pitchFromClimb: 0.6,
    /** Bank into turns: radians of roll per radian a second of turn, at most this. */
    bank: 5,
    maxBank: 0.14,
};

const HANDOFF = { idle: 5, ease: 4 };

type Pose = { position: THREE.Vector3; quaternion: THREE.Quaternion };

function createGlide() {
    let t = 0;
    const position = new THREE.Vector3();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const pose: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

    const angle = (time: number, period: number, phase = 0) => (time / period) * Math.PI * 2 + phase;
    const heading = (time: number) =>
        SUN_HEADING + GLIDE.offset + GLIDE.weave.reduce((sum, w) => sum + w.amount * Math.sin(angle(time, w.period, w.phase)), 0);
    const turnRate = (time: number) =>
        GLIDE.weave.reduce((sum, w) => sum + ((w.amount * Math.PI * 2) / w.period) * Math.cos(angle(time, w.period, w.phase)), 0);
    const { middle, swing, period } = GLIDE.altitude;
    const altitude = (time: number) => middle - swing * Math.cos(angle(time, period));
    const climb = (time: number) => ((swing * Math.PI * 2) / period) * Math.sin(angle(time, period));

    const update = () => {
        const h = heading(t);
        position.y = altitude(t);
        const pitch = GLIDE.pitch + GLIDE.pitchFromClimb * Math.atan(climb(t) / GLIDE.speed);
        const roll = THREE.MathUtils.clamp(-turnRate(t) * GLIDE.bank, -GLIDE.maxBank, GLIDE.maxBank);
        euler.set(pitch, Math.atan2(-Math.cos(h), -Math.sin(h)), roll);
        pose.position.copy(position);
        pose.quaternion.setFromEuler(euler);
    };
    update();

    return {
        pose,
        advance(dt: number) {
            const h = heading(t);
            position.x += Math.cos(h) * GLIDE.speed * dt;
            position.z += Math.sin(h) * GLIDE.speed * dt;
            t += dt;
            update();
        },
    };
}

/* the sky and the land */

const SKY = {
    zenith: [0.06, 0.15, 0.4],
    disc: 0.99972,
    glows: [
        { power: 260, amount: 1.4 },
        { power: 14, amount: 0.35 },
        { power: 3, amount: 0.08 },
    ],
};

const LAND = {
    green: [0.05, 0.075, 0.03],
    olive: [0.085, 0.085, 0.04],
    /** Metres across the drift between the two. */
    scale: 2600,
    shade: 0.7,
    /** The blue it takes from the sky, all it has in shadow. */
    skylight: [0.1, 0.13, 0.2],
    /** Metres of air that leave a third of the land showing through the haze. */
    haze: 1500,
};

function skyNode() {
    const dir = normalize(positionWorldDirection);
    const up = dir.y;
    const haze = hazeToward(dir);
    const sky = mix(haze, v3(SKY.zenith), pow(smoothstep(0.0, 1.0, up), 0.5));

    const altitude = max(cameraPosition.y, 1);
    const far = altitude.div(max(up.negate(), 0.0005));
    const ground = cameraPosition.add(dir.mul(far)).toVar();
    const drift = mx_noise_float(vec3(ground.xz.div(LAND.scale), 0.5))
        .mul(0.5)
        .add(0.5);
    const albedo = mix(v3(LAND.green), v3(LAND.olive), drift);
    const shadow = cloudShadow(ground).mul(smoothstep(9000, 4000, far));
    const sunOnLand = v3(LIGHT.sun)
        .mul(SUN_DIRECTION.y * 1.6)
        .mul(float(1).sub(shadow.mul(LAND.shade)));
    const land = albedo.mul(sunOnLand.add(v3(LAND.skylight)));
    const below = mix(haze, land, exp(far.div(-LAND.haze)));

    const base = up.greaterThan(0).select(sky, below);
    const toSun = max(dot(dir, v3([SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z])), 0);
    const disc = smoothstep(SKY.disc, SKY.disc + 0.00008, toSun)
        .mul(20)
        .mul(smoothstep(-0.01, 0.01, up));
    const glow = SKY.glows.map((g) => pow(toSun, g.power).mul(g.amount)).reduce((a, b) => a.add(b));
    return base.add(v3(LIGHT.sun).mul(disc.add(glow)));
}

/* post */

const BLOOM = { strength: 0.2, radius: 0.55, threshold: 1.05 };

const SHAFTS = {
    threshold: 1.0,
    reach: 0.75,
    strength: 0.6,
    samples: 48,
    decay: 0.975,
    colour: vec3(1, 0.85, 0.62),
};

const GRADE = { vignette: 0.3, tint: vec3(1.03, 1.0, 0.95) };

const sunOnScreen = uniform(new THREE.Vector2(0.5, 0.5));
const sunAhead = uniform(0);
const aspect = uniform(1);
const sunPoint = new THREE.Vector3();
const forward = new THREE.Vector3();

function placeSun(camera: THREE.PerspectiveCamera): void {
    sunPoint.copy(camera.position).addScaledVector(SUN_DIRECTION, 1000).project(camera);
    sunOnScreen.value.set(sunPoint.x * 0.5 + 0.5, 0.5 - sunPoint.y * 0.5);
    camera.getWorldDirection(forward);
    sunAhead.value = THREE.MathUtils.smoothstep(forward.dot(SUN_DIRECTION), 0.1, 0.5);
}

function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): RenderPipeline {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);
    const color = pass(scene, camera).getTextureNode('output');
    const glow = bloom(color, BLOOM.strength, BLOOM.radius, BLOOM.threshold);

    const offset = uv().sub(sunOnScreen).mul(vec2(aspect, 1));
    const near = smoothstep(SHAFTS.reach, 0, length(offset));
    const bright = max(dot(color.rgb, vec3(0.2126, 0.7152, 0.0722)).sub(SHAFTS.threshold), 0);
    const source = vec4(SHAFTS.colour.mul(bright.mul(near)), 1);
    const blurred: TslNode = radialBlur(source, {
        center: sunOnScreen,
        count: int(SHAFTS.samples),
        decay: float(SHAFTS.decay),
        weight: float(1),
        exposure: float(1),
    });
    // The blur hands back half its own source: keep only what it spread.
    const shafts = max(blurred.rgb.sub(source.rgb), 0).mul(SHAFTS.strength).mul(sunAhead);

    const vignette = smoothstep(0.35, 1.0, screenUV.sub(0.5).length().mul(1.35)).mul(GRADE.vignette).oneMinus();
    pipeline.outputNode = vec4(color.add(glow).rgb.add(shafts).mul(GRADE.tint).mul(vignette), 1);
    return pipeline;
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    scene.backgroundNode = skyNode();

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 6000);

    // WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const glide = createGlide();
    camera.position.copy(glide.pose.position);
    camera.quaternion.copy(glide.pose.quaternion);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 2;
    controls.maxDistance = 2500;
    let mode: 'glide' | 'user' | 'return' = 'glide';
    let holding = false;
    let letGo = 0;
    let elapsed = 0;
    let returning = 0;
    const from: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    controls.addEventListener('start', () => {
        if (mode !== 'user') {
            camera.getWorldDirection(forward);
            controls.target.copy(camera.position).addScaledVector(forward, 80);
        }
        mode = 'user';
        holding = true;
    });
    controls.addEventListener('end', () => {
        holding = false;
        letGo = elapsed;
    });

    const clouds = initClouds();
    const splats = new SplatRenderer({ renderer });
    splats.collection = new SplatCollection(clouds.objects);
    scene.add(splats);

    const pipeline = initPost(renderer, scene, camera);
    aspect.value = camera.aspect;

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        aspect.value = camera.aspect;
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

        if (mode === 'user') {
            controls.update();
            if (!holding && elapsed - letGo > HANDOFF.idle) {
                mode = 'return';
                returning = 0;
                from.position.copy(camera.position);
                from.quaternion.copy(camera.quaternion);
            }
        } else {
            glide.advance(dt);
            if (mode === 'return') returning += dt;
            const k = mode === 'return' ? THREE.MathUtils.smoothstep(returning, 0, HANDOFF.ease) : 1;
            camera.position.lerpVectors(from.position, glide.pose.position, k);
            camera.quaternion.slerpQuaternions(from.quaternion, glide.pose.quaternion, k);
            if (k >= 1) mode = 'glide';
        }

        updateClouds(elapsed, dt, camera);
        placeSun(camera);
        // The WebGL2 backend sorts on the CPU and only when asked; everything moves.
        if (splats.sortMode === 'cpu') splats.requestSort();
        pipeline.render();
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
