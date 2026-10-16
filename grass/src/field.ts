/**
 * The meadow: rolling hills of grass under drifting clouds, all generated on the
 * GPU from nothing but the splat index and the time. Nothing is stored, so the wind
 * costs nothing extra: every frame makes every blade afresh, already bent.
 *
 * The hills are a few long sine swells at odd angles, so the same height is cheap
 * on the CPU too and the camera can stand on them. A blade is a few splats strung
 * along a curve from its root to its tip: long along the blade, a narrow strip
 * across it, paper thin. The curve is a quadratic Bézier whose tip leans by the
 * blade's own rest lean plus the wind, so it bends from the root and curls most at
 * the tip, the way a stem does.
 *
 * The wind comes in fronts: noise stretched across the wind and sliding downwind,
 * so gusts are long bands combing over the hills, not blobs pulsing in place. It
 * veers slowly. Bent blades show more of their lighter face to the sky, so a front
 * reads as a brighter wave rolling through.
 *
 * The clouds ride the same wind, as one cover field at cloud height that's never
 * drawn: the grass looks up through it towards the sun, so all you see of them is
 * their shadows sweeping over the hills.
 */

import { GpuSplatMath, GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';

const {
    Fn,
    abs,
    clamp,
    cos,
    cross,
    dot,
    float,
    fract,
    length,
    max,
    min,
    mix,
    mx_fractal_noise_float,
    mx_noise_float,
    normalize,
    pow,
    sin,
    smoothstep,
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

/* the scene's numbers */

/** Towards the sun: mid-afternoon, ahead and to the right of the opening view. */
export const SUN_DIRECTION = new THREE.Vector3(0.5, 0.48, -0.72).normalize();

/**
 * Colours are sRGB-encoded, as splats blend. The haze is what the far field fades
 * into, and the sky's horizon is the same colour, so the field's edge disappears.
 */
export const HAZE: [number, number, number] = [0.8, 0.85, 0.88];
const SUN: [number, number, number] = [1.0, 0.93, 0.78];
/** What shadowed grass is lit by: the blue sky. */
const SKYLIGHT: [number, number, number] = [0.42, 0.5, 0.62];

const FIELD = {
    radius: 34,
    blades: 260_000,
    segments: 5,
    ground: 90_000,
    /** Below 1, blades crowd towards the middle, where the camera stands. */
    spread: 0.6,
    /** Where the fade into haze starts and is complete, metres from the camera. */
    fog: [9, 36],
};

/**
 * The hills: sine swells, each a direction (radians), a wavelength (metres), a
 * height and a phase. Long ones make the hills, short ones the lumps on them.
 */
const SWELLS = [
    { angle: 0.3, wavelength: 61, height: 1.1, phase: 0.7 },
    { angle: 1.9, wavelength: 43, height: 0.85, phase: 2.1 },
    { angle: 3.4, wavelength: 27, height: 0.35, phase: 4.0 },
    { angle: 5.1, wavelength: 13, height: 0.1, phase: 1.3 },
    { angle: 2.6, wavelength: 89, height: 1.4, phase: 5.2 },
];

const BLADE = {
    height: [0.3, 0.75],
    /** Half-width near the root (a splat's standard deviation), metres. */
    width: 0.009,
    thickness: 0.0015,
    /** How far a blade leans with no wind, radians. */
    restLean: 0.35,
    /**
     * Blades widen with distance from `farFrom` metres, up to `farGrowth` times, so
     * far ones overlap into turf instead of a grain of separate threads.
     */
    farFrom: 3,
    farGrowth: 10,
    /** The darkest a blade's root gets, down in the thatch. */
    rootShade: 0.3,
    deep: [0.08, 0.27, 0.05],
    fresh: [0.22, 0.5, 0.09],
    straw: [0.66, 0.63, 0.32],
    tip: [0.62, 0.8, 0.26],
};

const WIND = {
    /** The way it blows, radians in xz, and how far it veers either side. */
    angle: -0.45,
    veer: 0.3,
    /** How fast fronts travel, m/s. */
    speed: 5,
    /** A front's depth along the wind and its length across it, metres. */
    depth: 9,
    length: 34,
    /** Bend everyone has all the time, and the extra in a front, radians. */
    breeze: 0.14,
    gust: 0.95,
    /** A quick per-blade shiver, radians, and its rate in Hz. */
    flutter: 0.08,
    flutterRate: 2.4,
    /** How much lighter a fully bent blade shows. */
    sheen: 0.2,
};

const CLOUDS = {
    /** Height of the cloud layer, metres. */
    height: 160,
    /** How fast they drift with the wind, m/s. */
    speed: 7,
    /** The size of a cloud: one over metres. */
    scale: 0.011,
    /** The noise level where cloud starts, and where it's solid. */
    cover: [0.02, 0.3],
    /** The sunlight a cloud's shadow takes away. */
    shade: 0.72,
};

const GROUND = {
    thatch: [0.18, 0.15, 0.06],
    moss: [0.08, 0.16, 0.04],
};

/* uniforms, set once a frame */

/** Seconds since the start. */
export const time = uniform(0);
/** Where the camera is, for distance fog and backlight. */
export const eye = uniform(new THREE.Vector3());
/** The way the wind blows now, a unit xz vector. */
const windDir = uniform(new THREE.Vector2(1, 0));
/** How far the wind has carried the gusts and the clouds: integrated, so veering never jumps them. */
const gustTravel = uniform(new THREE.Vector2());
const cloudTravel = uniform(new THREE.Vector2());

/* the hills, on both sides */

/** Where the hills are sampled from: puts a hilltop at the field's middle, where you stand. */
const HILLTOP = [9.5, 1.5];

const SWELL_VECTORS = SWELLS.map((s) => ({
    x: (Math.cos(s.angle) * Math.PI * 2) / s.wavelength,
    z: (Math.sin(s.angle) * Math.PI * 2) / s.wavelength,
    ...s,
}));

/** Ground height at (x, z), on the CPU: the same sum the GPU makes. */
export function terrainHeight(x: number, z: number): number {
    let y = 0;
    for (const s of SWELL_VECTORS) y += s.height * Math.sin(s.x * (x + HILLTOP[0]) + s.z * (z + HILLTOP[1]) + s.phase);
    return y;
}

/** Ground height and its unit normal at an xz point, on the GPU. */
function terrain(xz: TslNode): { height: TslNode; normal: TslNode } {
    let height: TslNode = float(0);
    let slope: TslNode = vec2(0);
    for (const s of SWELL_VECTORS) {
        const phase = xz.x.add(HILLTOP[0]).mul(s.x).add(xz.y.add(HILLTOP[1]).mul(s.z)).add(s.phase);
        height = height.add(sin(phase).mul(s.height));
        slope = slope.add(vec2(s.x, s.z).mul(cos(phase).mul(s.height)));
    }
    return { height, normal: normalize(vec3(slope.x.negate(), 1, slope.y.negate())) };
}

/* clouds */

/**
 * Cloud cover at an xz point on the cloud layer, 0 clear to 1 solid. Inline, not
 * a laid-out `Fn`: a laid-out function is emitted once and its uniforms named by
 * whichever shader built it first, so one shared between shaders (as this was with
 * the sky) reads the wrong uniforms in all but one.
 */
function cloudCover(xz: TslNode): TslNode {
    const p = xz.sub(cloudTravel).mul(CLOUDS.scale);
    const n = mx_fractal_noise_float(vec3(p, time.mul(0.015)), 3, 2.1, 0.5);
    return smoothstep(CLOUDS.cover[0], CLOUDS.cover[1], n);
}

const sun = vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z);

/** The sunlight reaching a point, 1 in the clear: looks up towards the sun to the cloud layer. */
function sunlight(p: TslNode): TslNode {
    const up = float(CLOUDS.height).sub(p.y).div(sun.y);
    return cloudCover(p.xz.add(sun.xz.mul(up)))
        .mul(CLOUDS.shade)
        .oneMinus();
}

/* helpers */

const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);

/** Four hashes in [0, 1) of a seed. */
const hash4 = Fn(([i]: TslNode[]) => {
    const p = fract(vec3(i).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
    p.addAssign(dot(p, p.yzx.add(33.33)));
    const a = fract(p.xxy.add(p.yzz).mul(p.zyx));
    const w = fract(sin(i.mul(78.233)).mul(43758.5453));
    return vec4(a, w);
}).setLayout({ name: 'grassHash', type: 'vec4', inputs: [{ name: 'i', type: 'float' }] });

/** Shortest-arc rotation taking +Y onto `dir`. */
const alignY = (dir: TslNode): TslNode => normalize(vec4(cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));

/** A turn about +Y by `half` twice over. */
const yaw = (half: TslNode): TslNode => vec4(0, sin(half), 0, cos(half));

/**
 * Point `i` of `count` spread evenly over the field: a sunflower spiral, so there
 * are no clumps and no gaps, crowded towards the middle by `spread`. Returns the
 * xz point and how far out it is, 0..1.
 */
function spiral(i: TslNode, count: number, jitter: TslNode): { xz: TslNode; out: TslNode } {
    const t = i.add(jitter.x.mul(0.8)).div(count);
    const out = pow(t, FIELD.spread);
    const angle = i.mul(2.399963).add(jitter.y.mul(0.5));
    return { xz: vec2(cos(angle), sin(angle)).mul(out.mul(FIELD.radius)), out };
}

/** The far field's finish: fade towards the haze with distance, and out at the edge. */
function distance(center: TslNode, out: TslNode, rgb: TslNode): { rgb: TslNode; opacity: TslNode } {
    const fog = smoothstep(FIELD.fog[0], FIELD.fog[1], length(center.sub(eye)));
    return { rgb: mix(rgb, v3(HAZE), fog.mul(0.92)), opacity: smoothstep(1, 0.88, out) };
}

/** How much wider far splats draw, so a distant blade isn't thinner than a pixel. */
const farWidth = (center: TslNode): TslNode => clamp(length(center.sub(eye)).div(BLADE.farFrom), 1, BLADE.farGrowth);

/** One splat object, generated from its index alone. */
function generated(count: number, body: (index: TslNode) => TslNode): SplatObject {
    return SplatCollection.object({ count, generator: { generateSplat: body } });
}

/* the blades */

function blades(): SplatObject {
    const { segments } = FIELD;

    return generated(FIELD.blades * segments, (index) => {
        const blade = float(index.div(uint(segments)));
        const s = float(index.mod(uint(segments)))
            .add(0.5)
            .div(segments)
            .toVar();

        const a = hash4(blade.mul(1.37).add(0.5)).toVar();
        const b = hash4(blade.mul(7.13).add(3.1)).toVar();
        const c = hash4(blade.mul(3.71).add(11.7)).toVar();

        const { xz, out } = spiral(blade, FIELD.blades, a);
        const ground = terrain(xz);
        const root = vec3(xz.x, ground.height, xz.y).toVar();

        // Taller in patches, and patches of dry straw among the green.
        const lush = mx_noise_float(xz.mul(0.09)).mul(0.5).add(0.5);
        const height = mix(BLADE.height[0], BLADE.height[1], pow(b.x, 0.7))
            .mul(mix(0.65, 1.3, lush))
            .toVar();
        const dryPatch = mx_noise_float(xz.mul(0.05).add(7.3));
        const dry = smoothstep(0.25, 0.7, dryPatch.add(c.z.sub(0.5).mul(0.3))).mul(0.7);
        // Blade-to-blade variety, calmed with distance: far off it only reads as grain.
        const variety = mix(1, 0.2, smoothstep(5, 22, length(root.sub(eye))));

        // Fronts: noise in the wind's own frame, stretched across it, sliding downwind.
        const p = xz.sub(gustTravel);
        const along = dot(p, windDir);
        const across = dot(p, vec2(windDir.y.negate(), windDir.x));
        const front = mx_noise_float(vec3(along.div(WIND.depth), across.div(WIND.length), time.mul(0.07)));
        const gust = smoothstep(-0.2, 0.6, front).toVar();
        const shiver = sin(
            time
                .mul(Math.PI * 2 * WIND.flutterRate)
                .mul(c.x.mul(0.5).add(0.75))
                .add(c.y.mul(Math.PI * 2)),
        )
            .mul(WIND.flutter)
            .mul(gust.add(0.3));
        const leanAngle = b.z.mul(Math.PI * 2);
        const lean = vec2(cos(leanAngle), sin(leanAngle)).mul(b.w.mul(BLADE.restLean));
        const bend = lean.add(windDir.mul(gust.mul(WIND.gust).add(WIND.breeze).add(shiver))).toVar();
        const angle = min(length(bend), 1.35).toVar();
        const bendDir = bend.div(max(length(bend), 1e-4)).toVar();

        // The stem: a Bézier from the root, up, then over towards the tip.
        const over = vec3(bendDir.x, 0, bendDir.y);
        const tip = root.add(
            over
                .mul(sin(angle))
                .add(vec3(0, cos(angle), 0))
                .mul(height),
        );
        const knee = root.add(vec3(0, height.mul(0.6), 0)).add(over.mul(height.mul(sin(angle)).mul(0.25)));
        const center = root
            .mul(s.oneMinus().mul(s.oneMinus()))
            .add(knee.mul(s.oneMinus().mul(s).mul(2)))
            .add(tip.mul(s.mul(s)))
            .toVar();
        const tangent = normalize(knee.sub(root).mul(s.oneMinus()).add(tip.sub(knee).mul(s)));

        // Facing turns the blade about its own length; then it's stood along the stem.
        const quaternion = GpuSplatMath.quatMul(alignY(tangent), yaw(b.y.mul(Math.PI))).toVar();

        const widen = farWidth(center);
        const taper = mix(1, 0.3, pow(s, 1.6));
        const scales = vec3(
            float(BLADE.width).mul(taper).mul(widen),
            height.div(segments).mul(0.62),
            float(BLADE.thickness).mul(widen),
        );

        // Colour: dark in the thatch, lighter and yellower towards the tip.
        const green = mix(v3(BLADE.deep), v3(BLADE.fresh), c.w.sub(0.5).mul(variety).add(0.5));
        const base = mix(green, v3(BLADE.straw), dry);
        const body = mix(base, mix(base, v3(BLADE.tip), 0.55), smoothstep(0.3, 1, s));
        const shade = mix(BLADE.rootShade, 1, smoothstep(0, 0.85, s));

        // Light: the sky everywhere; the sun on the blade's face and on the hillside
        // it grows from, unless a cloud is in the way; through the blade when you
        // look towards the sun; and a sheen on blades a front has laid over.
        const lit = sunlight(center).toVar();
        const normal = GpuSplatMath.quatRotate(quaternion, vec3(0, 0, 1));
        const facing = abs(dot(normal, sun)).mul(0.5).add(0.5);
        const hillside = clamp(dot(ground.normal, sun).mul(1.3), 0.25, 1.1);
        const view = normalize(center.sub(eye));
        const through = pow(max(dot(view, sun), 0), 5)
            .mul(smoothstep(0.25, 1, s))
            .mul(0.6);
        const direct = v3(SUN).mul(facing.mul(hillside).add(through)).mul(lit);
        const rgb = body
            .mul(shade)
            .mul(direct.mul(0.95).add(v3(SKYLIGHT).mul(0.55)))
            .add(gust.mul(WIND.sheen).mul(s).mul(lit.mul(0.7).add(0.3)));

        const finish = distance(center, out, rgb);
        return GpuSplats.Splat(center, scales, quaternion, finish.rgb, finish.opacity, uint(index));
    });
}

/* the ground */

function ground(): SplatObject {
    // Each splat covers about its share of the field, so they overlap into a floor.
    const share = Math.sqrt((Math.PI * FIELD.radius ** 2) / FIELD.ground);

    return generated(FIELD.ground, (index) => {
        const i = float(index);
        const a = hash4(i.mul(2.17).add(91.3)).toVar();
        const b = hash4(i.mul(5.31).add(17.9)).toVar();
        const { xz, out } = spiral(i, FIELD.ground, a);
        const land = terrain(xz);
        const center = vec3(xz.x, land.height.add(b.x.mul(0.01)), xz.y).toVar();

        const size = mix(0.75, 1.4, out).mul(share).mul(b.y.mul(0.5).add(0.8));
        const scales = vec3(size, 0.004, size.mul(b.z.mul(0.5).add(0.5)));
        // Lying on the hillside, turned at random about it.
        const quaternion = GpuSplatMath.quatMul(alignY(land.normal), yaw(b.w.mul(Math.PI)));

        const mottle = mx_noise_float(xz.mul(0.7)).mul(0.5).add(0.5);
        const soil = mix(v3(GROUND.moss), v3(GROUND.thatch), mottle).mul(a.w.mul(0.3).add(0.85));
        // Far off, the gaps between blades should read as more grass, not as ground.
        const turf = mix(v3(BLADE.deep), v3(BLADE.fresh), 0.55);
        const body = mix(soil, turf, smoothstep(4, 18, length(center.sub(eye))));
        const direct = v3(SUN)
            .mul(max(dot(land.normal, sun), 0))
            .mul(sunlight(center));
        const rgb = body.mul(direct.mul(0.7).add(v3(SKYLIGHT).mul(0.5)));

        const finish = distance(center, out, rgb);
        return GpuSplats.Splat(center, scales, quaternion, finish.rgb, finish.opacity, uint(index));
    });
}

/* the field */

export type Field = { objects: SplatObject[] };

export function initField(): Field {
    return { objects: [ground(), blades()] };
}

export function updateField(elapsed: number, dt: number, camera: THREE.Camera): void {
    time.value = elapsed;
    eye.value.copy(camera.position);
    // The wind veers on two slow sines, and carries the gusts and clouds along it.
    const angle = WIND.angle + WIND.veer * (0.7 * Math.sin(elapsed * 0.031) + 0.3 * Math.sin(elapsed * 0.083 + 1.7));
    windDir.value.set(Math.cos(angle), Math.sin(angle));
    gustTravel.value.addScaledVector(windDir.value, WIND.speed * dt);
    cloudTravel.value.addScaledVector(windDir.value, CLOUDS.speed * dt);
}
