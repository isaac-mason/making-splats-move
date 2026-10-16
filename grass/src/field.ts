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

import {
    GpuSplatMath,
    GpuSplats,
    getGpuCaps,
    SplatCollection,
    type SplatObject,
    TSL,
    type TslNode,
    WgpuBuffer,
    WgpuCompute,
    WgpuComputeBatch,
} from 'spark-radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

const {
    If,
    abs,
    atan,
    clamp,
    cos,
    cross,
    dot,
    float,
    hash,
    length,
    max,
    min,
    mix,
    mx_noise_float,
    normalize,
    pow,
    sin,
    texture,
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
    /**
     * Half the size of the tile of meadow round you, metres. Everything in it is
     * drawn at whichever copy of its place is nearest you, so the meadow never
     * ends: what you leave behind comes round again out in the haze ahead.
     */
    reach: 30,
    blades: 260_000,
    segments: 5,
    ground: 90_000,
    /** Where the fade into haze starts and is complete, metres from the camera. */
    fog: [9, 30],
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
    veer: 0.2,
    /** How fast gusts travel, m/s. */
    speed: 4.5,
    /** A gust's depth along the wind and its length across it, metres. */
    depth: 8,
    length: 22,
    /** Bend everyone has all the time, and the extra in a gust, radians. */
    breeze: 0.12,
    gust: 0.75,
    /**
     * How long a blade takes to answer a gust, seconds, and how far it whips back
     * past where the gust left it as one lets go. This is the blade's weight.
     */
    respond: 0.35,
    whip: 0.4,
    /**
     * Each stem's own flutter: its angle (radians, more in a gust) and rate (Hz,
     * each stem somewhere in the range). Its own, not a wave running through the
     * field: a shared wave moves every blade in step, and reads as the ground
     * heaving rather than the grass blowing.
     */
    flutter: 0.075,
    flutterRate: [1.1, 2.4],
    /** How far each stem's lean strays from the wind's way, radians either side. */
    scatter: 0.35,
    /** A finer octave of gust riding the broad one, at this scale and weight. */
    detail: 0.36,
    detailWeight: 0.35,
    /** How much lighter a fully bent blade shows. */
    sheen: 0.2,
};

const CLOUDS = {
    /** Height of the cloud layer, metres. */
    height: 160,
    /** How fast they drift with the wind, m/s. */
    speed: 1.5,
    /**
     * Two layers of the one cloud picture, tiled: each a tile size (metres), an
     * angle, a speed against the drift, and an offset, so they never line up into
     * a grid. The second is fainter, a thinner cloud.
     */
    layers: [
        { tile: 30, angle: 0, speed: 1, offset: 0, weight: 1 },
        { tile: 47, angle: 0.9, speed: 1.25, offset: 0.37, weight: 0.8 },
    ],
    /** The picture's darkness where shadow starts, and where it's full. */
    cover: [0.08, 0.6],
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
/** Where you are: the meadow is centred on you, and you trample it. */
const you = uniform(new THREE.Vector3());
/** Your velocity, m/s. */
const yourVelocity = uniform(new THREE.Vector3());
/** Your stride: walking phase in cycles, for the bob. */
const stride = uniform(0);
const frameDt = uniform(1 / 60);
/** The way the wind blows now, a unit xz vector. */
const windDir = uniform(new THREE.Vector2(1, 0));
/** How far the wind has carried the gusts and the clouds: integrated, so veering never jumps them. */
const gustTravel = uniform(new THREE.Vector2());
const cloudTravel = uniform(new THREE.Vector2());

/** The cloud picture: one cloud on white, from the grass sketch this grew out of. Set in initField. */
let cloudMap: THREE.Texture;

/* the hills, on both sides */

/**
 * Where the hills are sampled from: puts you at the field's middle at the foot of
 * a long smooth rise to a crest, the way the sketch it came from looks.
 */
const HILLTOP = [-78, 80];

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
    let dark: TslNode = float(0);
    for (const layer of CLOUDS.layers) {
        const c = Math.cos(layer.angle);
        const sn = Math.sin(layer.angle);
        const p = xz.sub(cloudTravel.mul(layer.speed));
        const turned = vec2(p.x.mul(c).sub(p.y.mul(sn)), p.x.mul(sn).add(p.y.mul(c)));
        const uv = turned.div(layer.tile).add(layer.offset);
        // White is clear sky; the picture's darkness is the cloud.
        const shade = texture(cloudMap, uv).level(0).r.oneMinus().mul(layer.weight);
        dark = max(dark, shade);
    }
    return smoothstep(CLOUDS.cover[0], CLOUDS.cover[1], dark);
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

/**
 * Four independent numbers in [0, 1) for item `id`, from three's PCG integer hash.
 * Each `salt` is a separate stream. A float hash of neighbouring indices
 * correlates, and a field of blades shows it as a lattice; this doesn't.
 */
const hash4 = (id: TslNode, salt: number): TslNode => {
    const base = uint(id)
        .mul(uint(16))
        .add(uint(salt * 4));
    return vec4(hash(base), hash(base.add(uint(1))), hash(base.add(uint(2))), hash(base.add(uint(3))));
};

/** Shortest-arc rotation taking +Y onto `dir`. */
const alignY = (dir: TslNode): TslNode => normalize(vec4(cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));

/** A turn about +Y by `half` twice over. */
const yaw = (half: TslNode): TslNode => vec4(0, sin(half), 0, cos(half));

/**
 * A random point in the meadow from two random numbers: one place in the tile,
 * drawn at whichever copy of it is nearest you, so it holds still in the world
 * until you've gone far enough that it wraps round to the far side, out in the
 * haze. Plain random on purpose: it clumps a little, as grass does, where any
 * evenly spread scheme shows its pattern across a field. Returns the xz point and
 * how far out it is, 0..1, for the fade at the edge.
 */
function place(random: TslNode): { xz: TslNode; out: TslNode } {
    const size = FIELD.reach * 2;
    const local = random.xy.mul(size);
    const xz = local.add(you.xz.sub(local).div(size).round().mul(size)).toVar();
    return { xz, out: length(xz.sub(you.xz)).div(FIELD.reach) };
}

/** The far field's finish: fade towards the haze with distance, and out at the edge. */
function distance(center: TslNode, out: TslNode, rgb: TslNode): { rgb: TslNode; opacity: TslNode } {
    const fog = smoothstep(FIELD.fog[0], FIELD.fog[1], length(center.sub(eye)));
    return { rgb: mix(rgb, v3(HAZE), fog.mul(0.92)), opacity: smoothstep(1, 0.88, out) };
}

/** How much wider far splats draw, so a distant blade isn't thinner than a pixel. */
const farWidth = (center: TslNode): TslNode => clamp(length(center.sub(eye)).div(BLADE.farFrom), 1, BLADE.farGrowth);

/**
 * One splat object, generated from its index alone. `hard` draws opacity past 1 as
 * a crisper edge rather than a bigger splat (radix's LoD reading of it, turned
 * off). Good for separate shapes like petals; bad for grass, where a blade's
 * splats stack into one and hard rims show as separate leaves.
 */
function generated(count: number, body: (index: TslNode) => TslNode, hard = false): SplatObject {
    return SplatCollection.object({
        count,
        generator: { generateSplat: body },
        ...(hard ? { params: { lodInflate: false } } : {}),
    });
}

/* trampling, on the GPU */

/**
 * Where you've walked: a grid of grass state round you, simulated in a compute
 * kernel each frame. Each cell holds which way and how far its grass is pushed
 * over. You push the grass in your way outward and along your stride; every cell
 * springs back over a few seconds. The grid is addressed by world position and
 * wraps, like the meadow, and each cell remembers which bit of world it holds, so
 * it starts clean when it wraps round to new ground. Any speed, any length of
 * trail, and nothing per frame on the CPU but where you are. WebGPU only: with no
 * compute (the WebGL2 backend) the grass just doesn't trample.
 */
const TRAMPLE = {
    /** Cells across, and a cell's size in metres: 32 m of trail round you. */
    cells: 128,
    cell: 0.25,
    /** How close the grass is pushed, metres, and how far over (radians). */
    radius: 0.6,
    flatten: 1.25,
    /** How far your stride drags it along, against the outward push. */
    drag: 0.5,
    /** Seconds for trampled grass to get most of the way back up. */
    recover: 2.5,
};

type Trample = { grid: WgpuBuffer<'float32x4'>; kernel: WgpuCompute; batch: WgpuComputeBatch };
let trampleState: Trample | null = null;

/** `x` modulo `n`, always 0..n: WGSL's own keeps a negative's sign, and world cells go negative. */
const wrap = (x: TslNode, n: number): TslNode => x.sub(x.div(n).floor().mul(n));

/** The world cell that grid slot (i, j) holds now: of all that share it, the nearest you. */
function slotCell(i: TslNode, j: TslNode): TslNode {
    const n = TRAMPLE.cells;
    const yours = you.xz.div(TRAMPLE.cell).floor();
    const slot = vec2(i, j);
    const away = wrap(slot.sub(yours).add(n / 2), n).sub(n / 2);
    return yours.add(away);
}

function initTrample(renderer: WebGPURenderer): Trample {
    const n = TRAMPLE.cells;
    const grid = new WgpuBuffer({ renderer, format: 'float32x4', count: n * n });
    const kernel = new WgpuCompute({
        label: 'grassTrample',
        body: ({ index }) => {
            If(index.lessThan(uint(n * n)), () => {
                const i = float(index.mod(uint(n)));
                const j = float(index.div(uint(n)));
                const cell = slotCell(i, j);
                const state = grid.element(index).toVar();
                // New ground: the slot wrapped round to a cell it hasn't held.
                If(state.zw.notEqual(cell).any(), () => {
                    state.assign(vec4(0, 0, cell));
                });
                // Spring back.
                const push = state.xy.mul(frameDt.div(TRAMPLE.recover).mul(-2.3).exp()).toVar();
                // You: grass in your way pushed out from you and along your stride.
                const offset = cell.add(0.5).mul(TRAMPLE.cell).sub(you.xz);
                const reach = smoothstep(TRAMPLE.radius, TRAMPLE.radius * 0.25, length(offset));
                const moving = yourVelocity.xz;
                const along = moving.div(max(length(moving), 0.5)).mul(TRAMPLE.drag);
                const shove = normalize(offset.add(1e-4)).add(along).mul(TRAMPLE.flatten).mul(reach);
                // Toward the shove, quickly, but never less trampled than it was.
                const toward = mix(push, shove, clamp(frameDt.mul(12).mul(reach), 0, 1));
                push.assign(length(toward).greaterThan(length(push)).select(toward, push));
                grid.element(index).assign(vec4(push, cell));
            });
        },
    });
    return { grid, kernel, batch: new WgpuComputeBatch(renderer) };
}

/** How far the grass at `xz` is pushed over by your passing: an xz vector, its length in radians. */
function trampled(xz: TslNode): TslNode {
    const state = trampleState;
    if (!state) return vec2(0);
    const n = TRAMPLE.cells;
    const cell = xz.div(TRAMPLE.cell).floor();
    const slot = wrap(cell, n);
    const value = state.grid.element(uint(slot.y.mul(n).add(slot.x)));
    // Only if the slot holds this cell: otherwise it's a stale bit of somewhere else.
    return value.zw.equal(cell).all().select(value.xy, vec2(0));
}

/* the wind and the stem, shared by the grass and the flowers */

/**
 * The wind on a stem at `xz` of `height`, with its own random numbers `r`: how much
 * gust it feels (for the sheen) and how the wind pushes it over, an xz vector whose
 * length is the angle.
 *
 * Gusts: one broad pattern in the wind's own frame, stretched across it, sliding
 * downwind and barely changing shape as it goes. Because it only slides, what
 * reached a stem a moment ago is the pattern a little downwind of it: so a stem
 * answers the gust of `respond` seconds ago, and whips back past it by how fast
 * that gust was letting go.
 */
function windAt(xz: TslNode, height: TslNode, r: TslNode): { gust: TslNode; push: TslNode } {
    const p = xz.sub(gustTravel);
    const along = dot(p, windDir);
    const across = dot(p, vec2(windDir.y.negate(), windDir.x));
    // Rolling, not on-or-off: the broad pattern mapped gently, with a finer octave
    // sliding along with it.
    const gustAt = (ago: number) => {
        const a = along.add(WIND.speed * WIND.respond * ago);
        const broad = mx_noise_float(vec3(a.div(WIND.depth), across.div(WIND.length), time.mul(0.02)));
        const fine = mx_noise_float(
            vec3(a.div(WIND.depth * WIND.detail), across.div(WIND.length * WIND.detail), time.mul(0.03).add(17)),
        );
        return clamp(broad.add(fine.mul(WIND.detailWeight)).mul(0.8).add(0.45), 0, 1);
    };
    const felt = gustAt(1).toVar();
    // Lulls travel too: how hard it blows here is how hard it blew upwind, earlier.
    const local = time.sub(along.div(WIND.speed));
    const blowing = clamp(
        sin(local.mul(0.11).add(0.4))
            .mul(0.2)
            .add(sin(local.mul(0.047).add(2.1)).mul(0.15))
            .add(0.75),
        0.45,
        1.1,
    );
    const gust = clamp(felt.add(felt.sub(gustAt(2)).mul(WIND.whip)), 0, 1.15)
        .mul(blowing)
        .toVar();

    // Its own flutter: along the wind and a little across it, at its own rate.
    const rate = mix(WIND.flutterRate[0], WIND.flutterRate[1], r.x).mul(Math.PI * 2);
    const phase = r.y.mul(Math.PI * 2);
    const flutter = gust.add(0.25).mul(WIND.flutter);
    const shake = vec2(sin(time.mul(rate).add(phase)), sin(time.mul(rate.mul(1.37)).add(phase.mul(2.1))).mul(0.6)).mul(flutter);

    // Each stem leans a little its own way, so a gust doesn't lay the field over as one sheet.
    const stray = r.z.sub(0.5).mul(2 * WIND.scatter);
    const way = vec2(
        windDir.x.mul(cos(stray)).sub(windDir.y.mul(sin(stray))),
        windDir.x.mul(sin(stray)).add(windDir.y.mul(cos(stray))),
    );
    const sideways = vec2(way.y.negate(), way.x);

    // Taller stems catch more of it.
    const reach = clamp(height.div(BLADE.height[1]), 0.5, 1.3);
    const lay = gust.mul(WIND.gust).add(blowing.mul(0.5).add(0.5).mul(WIND.breeze));
    const push = way.mul(lay.add(shake.x)).add(sideways.mul(shake.y)).mul(reach);
    return { gust, push };
}

/**
 * A point `s` (0 root, 1 tip) along a stem of `height` from `root`, leant over by
 * `bend` (an xz vector, its length the angle): a Bézier up from the root then over
 * towards the tip, so it bends from the root and curls most at the tip. Returns
 * the point and the stem's direction there.
 */
function stem(root: TslNode, height: TslNode, bend: TslNode, s: TslNode): { center: TslNode; tangent: TslNode } {
    const angle = min(length(bend), 1.35).toVar();
    const bendDir = bend.div(max(length(bend), 1e-4)).toVar();
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
    return { center, tangent };
}

/* the blades */

function blades(): SplatObject {
    const { segments } = FIELD;

    return generated(FIELD.blades * segments, (index) => {
        const blade = index.div(uint(segments));
        const s = float(index.mod(uint(segments)))
            .add(0.5)
            .div(segments)
            .toVar();

        const a = hash4(blade, 0).toVar();
        const b = hash4(blade, 1).toVar();
        const c = hash4(blade, 2).toVar();

        const { xz, out } = place(a);
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

        const { gust, push } = windAt(xz, height, c);
        const leanAngle = b.z.mul(Math.PI * 2);
        const lean = vec2(cos(leanAngle), sin(leanAngle)).mul(b.w.mul(BLADE.restLean));
        const { center, tangent } = stem(root, height, lean.add(push).add(trampled(xz)), s);

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
            .add(max(gust, 0).mul(WIND.sheen).mul(s).mul(lit.mul(0.7).add(0.3)));

        const finish = distance(center, out, rgb);
        return GpuSplats.Splat(center, scales, quaternion, finish.rgb, finish.opacity, uint(index));
    });
}

/* the flowers */

/**
 * Wildflowers in drifts: a noise field says where they gather, and which kind
 * leads each drift, with strays of every kind in between.
 *
 * What keeps them from looking like stickers: each kind has its own shape (a
 * poppy's four broad cupped petals, a daisy's yellow dome in a ring of rays, a buttercup's
 * five glossy cups, a cornflower's ragged florets, a knapweed's upright tuft),
 * in muted colours; no two petals are quite alike, now and then one is missing;
 * heads are tipped every which way, so from eye height most are seen side-on;
 * some are still buds; and they stand at every height, some down in the grass.
 * They share the grass's wind and stem curve, a little stiffer.
 */
const FLOWERS = {
    count: 10_000,
    stemSegments: 3,
    /** Petal slots per flower: the most any kind has. */
    slots: 16,
    /** Petal opacity past 1, for a crisp petal edge. */
    crisp: 1.5,
    /** The size of a drift (one over metres), where one starts and is full, and the strays' share. */
    drift: 0.07,
    gather: [0.15, 0.5],
    strays: 0.05,
    height: [0.32, 0.82],
    /** The share still in bud. */
    buds: 0.18,
    stem: [0.2, 0.34, 0.1],
    /**
     * Each kind: petal and centre colour, how many petals, a petal's length
     * (metres) and width (of its length), how far the petals cup up (radians, below
     * 0 bends them back), and the eye's size: the centre, as a share of a petal's length.
     */
    kinds: [
        {
            name: 'poppy',
            petal: [0.8, 0.17, 0.09],
            centre: [0.1, 0.08, 0.07],
            petals: 4,
            length: 0.02,
            width: 0.85,
            cup: 0.55,
            eye: 0.32,
        },
        {
            name: 'cornflower',
            petal: [0.33, 0.45, 0.84],
            centre: [0.26, 0.26, 0.55],
            petals: 9,
            length: 0.013,
            width: 0.35,
            cup: 0.35,
            eye: 0.38,
        },
        {
            name: 'oxeye daisy',
            petal: [0.9, 0.89, 0.83],
            centre: [0.9, 0.66, 0.12],
            petals: 16,
            length: 0.013,
            width: 0.3,
            cup: -0.06,
            eye: 0.7,
        },
        {
            name: 'buttercup',
            petal: [0.92, 0.77, 0.16],
            centre: [0.82, 0.62, 0.14],
            petals: 5,
            length: 0.009,
            width: 0.75,
            cup: 0.75,
            eye: 0.32,
        },
        {
            name: 'knapweed',
            petal: [0.58, 0.3, 0.58],
            centre: [0.4, 0.24, 0.32],
            petals: 10,
            length: 0.008,
            width: 0.3,
            cup: 1.15,
            eye: 0.7,
        },
    ],
};

/** `values[kind]` for a kind index held as a float. */
function pick(kind: TslNode, values: TslNode[]): TslNode {
    let out = values[values.length - 1];
    for (let i = values.length - 2; i >= 0; i--) out = kind.lessThan(i + 0.5).select(values[i], out);
    return out;
}

/**
 * Where flower `flower` grows and how it stands now: its random numbers, its root,
 * whether its drift lets it show (`here`, 0..1), its height, and how the wind has
 * it bent. Shared with the butterflies, which land on the flowers.
 */
function flowerPlan(flower: TslNode) {
    const a = hash4(flower, 4).toVar();
    const b = hash4(flower, 5).toVar();
    const c = hash4(flower, 6).toVar();
    const { xz, out } = place(a);
    const root = vec3(xz.x, terrain(xz).height, xz.y).toVar();
    // Drifts: flowers only where the drift field gathers them, but for strays.
    const drift = mx_noise_float(xz.mul(FLOWERS.drift).add(41.7)).mul(0.5).add(0.5);
    const here = smoothstep(FLOWERS.gather[0], FLOWERS.gather[1], drift.sub(0.25)).max(
        c.z.lessThan(FLOWERS.strays).select(float(1), float(0)),
    );
    const height = mix(FLOWERS.height[0], FLOWERS.height[1], b.x).toVar();
    const { gust, push } = windAt(xz, height, c);
    // A little stiffer than grass, and each with a lean of its own.
    const bend = push
        .mul(0.75)
        .add(vec2(cos(b.y.mul(6.283)), sin(b.y.mul(6.283))).mul(0.15))
        .add(trampled(xz));
    return { a, b, c, xz, out, root, here, height, gust, bend };
}

function flowers(): SplatObject {
    const { stemSegments, slots, kinds } = FLOWERS;
    const parts = stemSegments + slots + 1;
    const of = (key: 'petals' | 'length' | 'width' | 'cup' | 'eye') => (kind: TslNode) =>
        pick(
            kind,
            kinds.map((k) => float(k[key])),
        );

    return generated(
        FLOWERS.count * parts,
        (index) => {
            const flower = index.div(uint(parts));
            const part = float(index.mod(uint(parts))).toVar();
            // This petal's own numbers, so no two are alike.
            const own = hash4(index, 7).toVar();
            const { a, b, c, xz, out, root, here, height, gust, bend } = flowerPlan(flower);

            // The drift's own kind, or now and then any kind.
            const driftKind = mx_noise_float(xz.mul(FLOWERS.drift * 0.6).add(5.1))
                .mul(0.5)
                .add(0.5)
                .mul(kinds.length);
            const kind = c.w
                .lessThan(0.25)
                .select(c.x.mul(kinds.length), driftKind)
                .floor()
                .clamp(0, kinds.length - 1)
                .toVar();
            const bud = c.y.lessThan(FLOWERS.buds);

            const isStem = part.lessThan(stemSegments);
            const isCentre = part.equal(parts - 1);
            const slot = part.sub(stemSegments);
            const along = stem(root, height, bend, part.add(0.5).div(stemSegments).min(1));
            const head = stem(root, height, bend, float(1));

            // The head nods with the stem and is tipped its own way: most are seen side-on.
            const tipAngle = a.z.mul(6.283);
            const tip = vec3(cos(tipAngle), 0, sin(tipAngle)).mul(a.w.mul(0.9));
            const facing = normalize(
                head.tangent
                    .add(vec3(0, 0.5, 0))
                    .add(sun.mul(0.25))
                    .add(tip),
            ).toVar();

            // Petals round the head, evenly but not exactly, each its own size, cupped.
            const count = of('petals')(kind);
            const scale = b.w.mul(0.5).add(0.75);
            const length = of('length')(kind).mul(scale).mul(own.x.mul(0.4).add(0.8)).toVar();
            const width = of('width')(kind).mul(own.y.mul(0.4).add(0.8));
            const cup = of('cup')(kind).add(own.z.sub(0.5).mul(0.3));
            const turn = slot.add(own.w.sub(0.5).mul(0.35)).div(count).add(b.z).mul(Math.PI);
            const headTurn = GpuSplatMath.quatMul(alignY(facing), yaw(turn)).toVar();
            const petalTurn = GpuSplatMath.quatMul(headTurn, vec4(0, 0, sin(cup.mul(0.5)), cos(cup.mul(0.5))));
            const centreSize = of('eye')(kind)
                .mul(of('length')(kind))
                .mul(scale)
                .mul(bud.select(float(1.4), float(1)))
                .toVar();
            // Petals radiate from the edge of the eye, not from under it.
            const petalAt = head.center.add(
                GpuSplatMath.quatRotate(petalTurn, vec3(centreSize.mul(0.8).add(length.mul(0.95)), 0, 0)),
            );
            // The eye sits a little proud of the petals, a dome, so it shows.
            const eyeAt = head.center.add(facing.mul(centreSize.mul(0.35)));

            const center = isStem.select(along.center, isCentre.select(eyeAt, petalAt)).toVar();
            const quaternion = isStem.select(alignY(along.tangent), isCentre.select(headTurn, petalTurn));
            const scales = isStem.select(
                vec3(0.0025, height.div(stemSegments).mul(0.6), 0.0025),
                isCentre.select(vec3(centreSize, centreSize.mul(0.6), centreSize), vec3(length, 0.0012, length.mul(width))),
            );

            // Which splats show: the stem; petals this kind has (one in twenty-five
            // gone), not on a bud; the centre always.
            const petalShows = slot.lessThan(count).and(own.z.greaterThan(0.04)).and(bud.not());
            const shows = isStem.or(isCentre).or(petalShows).select(float(1), float(0));

            // Colour: muted, each petal a touch different; a bud is green going over
            // to its colour. Lit as the grass is.
            const petalColour = pick(
                kind,
                kinds.map((k) => v3(k.petal)),
            ).mul(own.y.mul(0.16).add(0.92));
            const centreColour = bud.select(
                mix(
                    v3(FLOWERS.stem),
                    pick(
                        kind,
                        kinds.map((k) => v3(k.petal)),
                    ),
                    0.35,
                ),
                pick(
                    kind,
                    kinds.map((k) => v3(k.centre)),
                ),
            );
            const body = isStem.select(v3(FLOWERS.stem), isCentre.select(centreColour, petalColour));
            const lit = sunlight(center);
            const view = normalize(center.sub(eye));
            const through = pow(max(dot(view, sun), 0), 4).mul(isStem.select(float(0), float(0.3)));
            const faceSun = abs(dot(GpuSplatMath.quatRotate(quaternion, vec3(0, 1, 0)), sun))
                .mul(0.5)
                .add(0.5);
            const rgb = body.mul(v3(SUN).mul(faceSun.add(through)).mul(lit).mul(0.9).add(v3(SKYLIGHT).mul(0.5))).add(
                max(gust, 0)
                    .mul(0.03)
                    .mul(isStem.select(float(0), float(1))),
            );

            const finish = distance(center, out, rgb);
            const crisp = isStem.select(float(1), float(FLOWERS.crisp));
            return GpuSplats.Splat(
                center,
                scales,
                quaternion,
                finish.rgb.min(0.95),
                finish.opacity.mul(here).mul(shows).mul(crisp),
                uint(index),
            );
        },
        true,
    );
}

/* the butterflies */

/**
 * Butterflies working the flowers all over the meadow. Each goes from flower to
 * flower: it rests on one (wings closed upright, opening flat now and then to bask,
 * swaying with the flower in the wind), takes off, flies an eased, curving path
 * with a rise in the middle, and lands on the next. The flowers are the real ones:
 * a butterfly picks, of a few at random, the one nearest its patch that its drift
 * lets show, and sits on its head.
 *
 * A body, two antennae, and on each side a forewing (a broad inner part and a
 * pointed tip swept forward) and a rounded hindwing, hinged at the body. Wings
 * beat a few times a second with a brief glide now and then. Seen from below
 * they show their duller underside. They're crisp, like the petals, and thin
 * enough to glow with the sun behind them.
 */
const BUTTERFLIES = {
    count: 120,
    /** How many flowers each looks at to choose its next. */
    choices: 6,
    /** Seconds per flower, rest and flight together, and the share spent resting. */
    visit: [9, 15],
    rest: [0.25, 0.45],
    /** How far a flight swings out to the side and rises in the middle, metres. */
    swing: 1.4,
    rise: [0.3, 0.8],
    /** Wingbeats a second (slow enough not to alias into a buzz), and a wing's span from the body, metres. */
    flap: [3.5, 5.5],
    span: [0.026, 0.038],
    /** Each kind: forewing, its tip, hindwing, and the underside. */
    kinds: [
        {
            name: 'cabbage white',
            fore: [0.96, 0.95, 0.88],
            tip: [0.2, 0.2, 0.19],
            hind: [0.95, 0.94, 0.85],
            under: [0.88, 0.9, 0.7],
        },
        {
            name: 'fritillary',
            fore: [0.94, 0.5, 0.12],
            tip: [0.42, 0.2, 0.07],
            hind: [0.86, 0.44, 0.12],
            under: [0.84, 0.7, 0.45],
        },
        {
            name: 'common blue',
            fore: [0.45, 0.6, 0.97],
            tip: [0.3, 0.32, 0.45],
            hind: [0.47, 0.57, 0.9],
            under: [0.76, 0.73, 0.68],
        },
        {
            name: 'brimstone',
            fore: [0.97, 0.92, 0.45],
            tip: [0.93, 0.86, 0.38],
            hind: [0.95, 0.9, 0.45],
            under: [0.84, 0.9, 0.55],
        },
    ],
    body: [0.1, 0.08, 0.06],
};

function butterflies(): SplatObject {
    const { kinds } = BUTTERFLIES;
    // The body, two antennae, and three wing pieces each side.
    const parts = 9;

    return generated(
        BUTTERFLIES.count * parts,
        (index) => {
            const fly = index.div(uint(parts));
            const part = float(index.mod(uint(parts))).toVar();
            const a = hash4(fly, 8).toVar();
            const b = hash4(fly, 9).toVar();
            const c = hash4(fly, 10).toVar();
            const t = time;

            // Its patch: a place in the meadow, wrapping round you like everything else.
            const home = place(a.xy).xz;

            // The flower of visit k: of a few at random, the nearest that shows. Its
            // head, where the butterfly sits, moves with the flower in the wind.
            const flowerFor = (k: TslNode): TslNode => {
                let best: TslNode | null = null;
                let bestScore: TslNode | null = null;
                for (let j = 0; j < BUTTERFLIES.choices; j++) {
                    const pickId = uint(
                        hash(
                            uint(fly)
                                .mul(uint(7919))
                                .add(uint(k).mul(uint(131)))
                                .add(uint(j)),
                        ).mul(FLOWERS.count),
                    );
                    const plan = flowerPlan(pickId);
                    const head = stem(plan.root, plan.height, plan.bend, float(1)).center;
                    const score = length(plan.xz.sub(home)).add(plan.here.oneMinus().mul(50));
                    if (!best || !bestScore) {
                        best = head;
                        bestScore = score;
                    } else {
                        const better = score.lessThan(bestScore);
                        best = better.select(head, best);
                        bestScore = better.select(score, bestScore);
                    }
                }
                return (best as TslNode).toVar();
            };

            // Visits: rest on one flower, then fly to the next.
            const period = mix(BUTTERFLIES.visit[0], BUTTERFLIES.visit[1], b.x);
            const clock = t.div(period).add(b.y.mul(10));
            const k = clock.floor().toVar();
            const u = clock.fract().toVar();
            const restShare = mix(BUTTERFLIES.rest[0], BUTTERFLIES.rest[1], b.z);
            const before = flowerFor(k.sub(1));
            const from = flowerFor(k);
            const to = flowerFor(k.add(1));

            const v = clamp(u.sub(restShare).div(restShare.oneMinus()), 0, 1).toVar();
            const eased = v.mul(v).mul(v.mul(-2).add(3));
            const across = to.xz.sub(from.xz);
            const side = normalize(vec2(across.y.negate(), across.x).add(1e-5));
            const swing = c.x.sub(0.5).mul(2 * BUTTERFLIES.swing);
            const arc = sin(v.mul(Math.PI));
            const rise = mix(BUTTERFLIES.rise[0], BUTTERFLIES.rise[1], c.y);
            const flying = smoothstep(0, 0.04, v)
                .mul(smoothstep(1, 0.96, v))
                .toVar();

            // Wingbeats, and now and then a brief glide with the wings held up,
            // still quivering. Resting: closed upright, opening flat now and then.
            const rate = mix(BUTTERFLIES.flap[0], BUTTERFLIES.flap[1], c.z);
            const beat = sin(
                t
                    .mul(rate)
                    .mul(Math.PI * 2)
                    .add(c.w.mul(6.283)),
            );
            const glide = smoothstep(0.88, 0.97, sin(t.mul(0.8).add(c.z.mul(6.283))));
            const flapping = mix(beat, beat.mul(0.15).add(0.35), glide).mul(0.65).add(0.35);
            const bask = smoothstep(0.55, 0.9, sin(t.mul(0.7).add(a.w.mul(6.283))));
            const resting = mix(1.45, 0.12, bask);
            const wing = mix(resting, flapping, flying);

            const path = mix(from, to, eased)
                .add(vec3(side.x, 0, side.y).mul(swing.mul(arc.mul(arc))))
                .add(vec3(0, 1, 0).mul(rise.mul(arc)))
                .add(vec3(0, 1, 0).mul(beat.mul(0.01).mul(flying)));
            const body = path.add(vec3(0, 0.008, 0)).toVar();

            // Facing: the way it last flew while resting; the way it's going in flight.
            const landedFacing = normalize(from.xz.sub(before.xz).add(1e-5));
            const goingFacing = normalize(
                across.mul(eased.sub(eased.mul(eased)).add(0.02)).add(side.mul(swing.mul(sin(v.mul(Math.PI * 2))).mul(0.6))),
            );
            const ahead = normalize(mix(landedFacing, goingFacing, smoothstep(0, 0.15, v)));
            const facing = yaw(atan(ahead.x, ahead.y).mul(0.5)).toVar();

            // Parts: 0 the body; 1, 2 the antennae; then each side a forewing's inner
            // part, its tip, and the hindwing.
            const isBody = part.equal(0);
            const isAntenna = part.greaterThan(0.5).and(part.lessThan(2.5));
            const wingPart = part.sub(3).max(0);
            const piece = wingPart.mod(3);
            const flank = isAntenna.select(
                part.equal(1).select(float(-1), float(1)),
                wingPart.lessThan(2.5).select(float(-1), float(1)),
            );
            const span = mix(BUTTERFLIES.span[0], BUTTERFLIES.span[1], a.z);

            const roll = flank.mul(wing).mul(0.5);
            const hinged = GpuSplatMath.quatMul(facing, vec4(0, 0, sin(roll), cos(roll)));
            // Each piece: where it sits on the wing, and how it's turned in the wing's plane.
            const isTip = piece.equal(1);
            const isHind = piece.equal(2);
            const spot = isHind.select(vec3(0.42, 0, -0.3), isTip.select(vec3(0.86, 0, 0.36), vec3(0.48, 0, 0.16)));
            const sweep = isHind.select(float(-0.35), isTip.select(float(0.75), float(0.45)));
            const size = isHind.select(vec3(0.3, 0, 0.27), isTip.select(vec3(0.2, 0, 0.14), vec3(0.34, 0, 0.26)));
            const wingTurn = GpuSplatMath.quatMul(hinged, yaw(flank.mul(sweep).mul(0.5)));
            const wingAt = body.add(GpuSplatMath.quatRotate(hinged, spot.mul(vec3(flank, 1, 1)).mul(span)));

            const antennaTurn = GpuSplatMath.quatMul(
                GpuSplatMath.quatMul(facing, vec4(sin(0.45), 0, 0, cos(0.45))),
                vec4(0, 0, flank.mul(0.15).sin(), flank.mul(0.15).cos()),
            );
            const antennaAt = body.add(GpuSplatMath.quatRotate(facing, vec3(flank.mul(0.003), 0.007, span.mul(0.5).add(0.007))));

            const center = isBody.select(body, isAntenna.select(antennaAt, wingAt)).toVar();
            const quaternion = isBody.select(facing, isAntenna.select(antennaTurn, wingTurn)).toVar();
            const scales = isBody.select(
                vec3(0.0026, 0.0026, span.mul(0.55)),
                isAntenna.select(vec3(0.0006, 0.008, 0.0006), size.mul(span).add(vec3(0, 0.001, 0))),
            );

            // Colour: the kind's wing, its marked tip, the hindwing, or the duller
            // underside when it's seen from below; lit like everything else, and
            // through the wings towards the sun.
            const kind = a.w.add(c.x).fract().mul(kinds.length).floor();
            const choose = (key: 'fore' | 'tip' | 'hind' | 'under') =>
                pick(
                    kind,
                    kinds.map((kd) => v3(kd[key])),
                );
            const view = normalize(center.sub(eye));
            const normal = GpuSplatMath.quatRotate(quaternion, vec3(0, 1, 0));
            // The wing's top faces along its normal; closed upright, the tops face
            // each other and the undersides face out, as they should.
            const fromBelow = dot(normal, view).greaterThan(0);
            const top = isHind.select(choose('hind'), isTip.select(choose('tip'), choose('fore')));
            const wingColour = fromBelow.select(choose('under').mul(isTip.select(float(0.85), float(1))), top);
            const colour = isBody.or(isAntenna).select(v3(BUTTERFLIES.body), wingColour);
            const through = pow(max(dot(view, sun), 0), 4).mul(isBody.or(isAntenna).select(float(0), float(0.8)));
            const lit = sunlight(center);
            const rgb = colour.mul(
                v3(SUN)
                    .mul(abs(dot(normal, sun)).mul(0.6).add(0.4).add(through))
                    .mul(lit)
                    .add(v3(SKYLIGHT).mul(0.5)),
            );

            const finish = distance(center, float(0), rgb);
            // Crisp, like the petals: each wing piece is one shape. Antennae stay fine.
            const crisp = isAntenna.select(float(1), float(1.7));
            return GpuSplats.Splat(center, scales, quaternion, finish.rgb.min(0.97), finish.opacity.mul(crisp), uint(index));
        },
        true,
    );
}

/* you */

/**
 * You: a capsule of splats standing in the grass, lit like everything else. It
 * bobs as it walks and leans into its stride.
 */
const YOU = {
    /** Splats over its surface. */
    splats: 900,
    radius: 0.26,
    /** Height of the straight part between the two round ends, metres. */
    middle: 0.9,
    colour: [0.88, 0.5, 0.36],
    /** How far it leans into its stride, radians per m/s, and bobs, metres. */
    lean: 0.035,
    bob: 0.035,
};

function capsule(): SplatObject {
    const { splats, radius, middle } = YOU;
    // Spread over the surface by area: the round ends and the straight middle.
    const capArea = 4 * Math.PI * radius * radius;
    const sideArea = 2 * Math.PI * radius * middle;
    const onSide = sideArea / (capArea + sideArea);

    return generated(
        splats,
        (index) => {
            const r = hash4(index, 12).toVar();
            const i = float(index);
            // An even spiral round it, a golden angle a step, a little jittered.
            const around = i.mul(2.399963).add(r.x.mul(0.4));
            const t = i.add(r.y).div(splats);
            const side = t.lessThan(onSide);
            // On the side: straight up the middle. On the ends: a hemisphere each.
            const sideY = t.div(onSide).sub(0.5).mul(middle);
            const capT = t.sub(onSide).div(1 - onSide);
            const top = capT.greaterThan(0.5);
            const capU = capT.mul(2).fract();
            const lat = capU.acos();
            const normal = side
                .select(
                    vec3(cos(around), 0, sin(around)),
                    vec3(cos(around).mul(lat.sin()), top.select(lat.cos(), lat.cos().negate()), sin(around).mul(lat.sin())),
                )
                .toVar();
            const anchor = side.select(sideY, top.select(float(middle / 2), float(-middle / 2)));
            const local = normal.mul(radius).add(vec3(0, anchor, 0));

            // Standing on the ground under you, bobbing, leaning into the stride.
            const speed = length(yourVelocity.xz);
            const bob = sin(stride.mul(Math.PI * 2))
                .abs()
                .mul(YOU.bob)
                .mul(clamp(speed.div(2), 0, 1));
            const height = local.y.add(middle / 2 + radius);
            const lean = yourVelocity.xz.mul(YOU.lean).mul(height);
            const center = you.add(vec3(local.x.add(lean.x), height.add(bob), local.z.add(lean.y))).toVar();

            const quaternion = alignY(normal);
            const size = radius * 0.16;
            const scales = vec3(size, 0.012, size);

            const lit = sunlight(center);
            const rgb = v3(YOU.colour)
                .mul(r.z.mul(0.08).add(0.96))
                .mul(
                    v3(SUN)
                        .mul(max(dot(normal, sun), 0).mul(0.85))
                        .mul(lit)
                        .add(v3(SKYLIGHT).mul(0.6)),
                );
            const finish = distance(center, float(0), rgb);
            return GpuSplats.Splat(center, scales, quaternion, finish.rgb, finish.opacity.mul(1.4), uint(index));
        },
        true,
    );
}

/* the ground */

function ground(): SplatObject {
    // Each splat covers about its share of the field, so they overlap into a floor.
    const share = Math.sqrt((2 * FIELD.reach) ** 2 / FIELD.ground);

    return generated(FIELD.ground, (index) => {
        const a = hash4(index, 0).toVar();
        const b = hash4(index, 1).toVar();
        const { xz, out } = place(a);
        const land = terrain(xz);
        const center = vec3(xz.x, land.height.add(b.x.mul(0.01)), xz.y).toVar();

        const size = float(share).mul(b.y.mul(0.5).add(0.8));
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

/** `clouds` is the cloud picture, already loaded: dark cloud on white. */
export function initField(renderer: WebGPURenderer, clouds: THREE.Texture): Field {
    clouds.wrapS = clouds.wrapT = THREE.RepeatWrapping;
    clouds.colorSpace = THREE.NoColorSpace;
    cloudMap = clouds;
    // Before the generators: they read the trample grid if there is one.
    trampleState = getGpuCaps(renderer).compute ? initTrample(renderer) : null;
    return { objects: [ground(), blades(), flowers(), butterflies(), capsule()] };
}

/** Where you are and how you're moving, for the meadow round you. */
export type Walker = { position: THREE.Vector3; velocity: THREE.Vector3; stride: number };

export function updateField(elapsed: number, dt: number, camera: THREE.Camera, walker: Walker): void {
    time.value = elapsed;
    frameDt.value = Math.max(dt, 1e-4);
    eye.value.copy(camera.position);
    you.value.copy(walker.position);
    yourVelocity.value.copy(walker.velocity);
    stride.value = walker.stride;
    if (trampleState) trampleState.batch.add(trampleState.kernel, TRAMPLE.cells ** 2).submit();
    // The wind veers on two slow sines, and carries the gusts and clouds along it.
    const angle = WIND.angle + WIND.veer * (0.7 * Math.sin(elapsed * 0.031) + 0.3 * Math.sin(elapsed * 0.083 + 1.7));
    windDir.value.set(Math.cos(angle), Math.sin(angle));
    gustTravel.value.addScaledVector(windDir.value, WIND.speed * dt);
    cloudTravel.value.addScaledVector(windDir.value, CLOUDS.speed * dt);
}
