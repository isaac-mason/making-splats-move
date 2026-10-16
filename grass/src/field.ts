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
     * A gentle sway that ripples through the grass as a travelling wave: its
     * angle, rate (Hz), and wavelength along the wind (metres). Neighbours sway
     * together, so you see the ripples pass.
     */
    sway: 0.05,
    swayRate: 0.6,
    swayLength: 5,
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
 * A random point on the field from two random numbers, crowded towards the middle
 * by `spread` (0.5 would be even). Plain random on purpose: it clumps a little,
 * as grass does, where any evenly spread scheme shows its pattern across a field.
 * Returns the xz point and how far out it is, 0..1.
 */
function scatter(random: TslNode): { xz: TslNode; out: TslNode } {
    const out = pow(random.x, FIELD.spread);
    const angle = random.y.mul(Math.PI * 2);
    return { xz: vec2(cos(angle), sin(angle)).mul(out.mul(FIELD.radius)), out };
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

/* the wind and the stem, shared by the grass and the flowers */

/**
 * The wind on a stem at `xz` of `height`, with its own random numbers `r`: how much
 * gust it feels (for the sheen) and how far the wind pushes it over, radians.
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

    // The sway: a ripple running through the grass downwind, each stem a touch off
    // its neighbours' rate and phase so it isn't a sheet.
    const downwind = dot(xz, windDir).div(WIND.swayLength);
    const sway = sin(
        downwind
            .sub(time.mul(WIND.swayRate).mul(r.x.sub(0.5).mul(0.25).add(1)))
            .add(r.y.mul(0.15))
            .mul(Math.PI * 2),
    ).mul(gust.mul(0.8).add(0.35).mul(WIND.sway));

    // Taller stems catch more of it.
    const reach = clamp(height.div(BLADE.height[1]), 0.5, 1.3);
    const push = gust.mul(WIND.gust).add(blowing.mul(0.5).add(0.5).mul(WIND.breeze)).add(sway).mul(reach);
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

        const { xz, out } = scatter(a);
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
        const { center, tangent } = stem(root, height, lean.add(windDir.mul(push)), s);

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
 * leads each drift, with strays of every kind in between. Each is a thin stem and
 * a head: a ring of petals, tipped up towards the sky and a little towards the
 * sun, round a centre. They stand just above the grass so the heads show, and
 * take the same wind, so they bob in the same gusts.
 */
const FLOWERS = {
    count: 14_000,
    stemSegments: 3,
    petals: 8,
    /** Petal opacity past 1, for a crisp petal edge. */
    crisp: 1.7,
    /** The size of a drift (one over metres), where one starts and is full, and the strays' share. */
    drift: 0.07,
    gather: [0.15, 0.5],
    strays: 0.05,
    height: [0.5, 0.9],
    stem: [0.17, 0.36, 0.08],
    /** Petals, each kind: colour, centre colour, petal length (metres), and its share of drifts. */
    kinds: [
        { name: 'poppy', petal: [0.96, 0.2, 0.07], centre: [0.12, 0.07, 0.08], size: 0.03 },
        { name: 'cornflower', petal: [0.3, 0.45, 0.96], centre: [0.2, 0.22, 0.6], size: 0.021 },
        { name: 'daisy', petal: [0.98, 0.97, 0.92], centre: [1.0, 0.78, 0.12], size: 0.024 },
        { name: 'buttercup', petal: [1.0, 0.84, 0.1], centre: [0.95, 0.68, 0.08], size: 0.017 },
        { name: 'knapweed', petal: [0.72, 0.32, 0.78], centre: [0.45, 0.18, 0.5], size: 0.019 },
    ],
};

/** `values[kind]` for a kind index held as a float. */
function pick(kind: TslNode, values: TslNode[]): TslNode {
    let out = values[values.length - 1];
    for (let i = values.length - 2; i >= 0; i--) out = kind.lessThan(i + 0.5).select(values[i], out);
    return out;
}

function flowers(): SplatObject {
    const { stemSegments, petals, kinds } = FLOWERS;
    const parts = stemSegments + petals + 1;

    return generated(
        FLOWERS.count * parts,
        (index) => {
            const flower = index.div(uint(parts));
            const part = float(index.mod(uint(parts))).toVar();
            const a = hash4(flower, 4).toVar();
            const b = hash4(flower, 5).toVar();
            const c = hash4(flower, 6).toVar();

            const { xz, out } = scatter(a);
            const ground = terrain(xz);
            const root = vec3(xz.x, ground.height, xz.y);

            // Drifts: flowers only where the drift field gathers them, but for strays.
            const drift = mx_noise_float(xz.mul(FLOWERS.drift).add(41.7)).mul(0.5).add(0.5);
            const here = smoothstep(FLOWERS.gather[0], FLOWERS.gather[1], drift.sub(0.25)).max(
                c.z.lessThan(FLOWERS.strays).select(float(1), float(0)),
            );
            // The drift's own kind, or now and then any kind.
            const driftKind = mx_noise_float(xz.mul(FLOWERS.drift * 0.6).add(5.1))
                .mul(0.5)
                .add(0.5)
                .mul(kinds.length);
            const kind = c.w.lessThan(0.25).select(c.x.mul(kinds.length), driftKind).floor().toVar();

            const height = mix(FLOWERS.height[0], FLOWERS.height[1], b.x).toVar();
            const { gust, push } = windAt(xz, height, c);
            // A little stiffer than grass.
            const bend = windDir.mul(push.mul(0.75)).add(vec2(cos(b.y.mul(6.283)), sin(b.y.mul(6.283))).mul(0.12));

            const isStem = part.lessThan(stemSegments);
            const isCentre = part.equal(parts - 1);
            const s = part.add(0.5).div(stemSegments).min(1);
            const along = stem(root, height, bend, s);
            const head = stem(root, height, bend, float(1));

            // The head looks up, a little towards the sun, and leans with the stem.
            const facing = normalize(head.tangent.add(vec3(0, 1.2, 0)).add(sun.mul(0.35))).toVar();
            const petal = part.sub(stemSegments);
            const turn = petal.div(petals).add(b.z).mul(Math.PI);
            const headTurn = GpuSplatMath.quatMul(alignY(facing), yaw(turn)).toVar();
            const size = pick(
                kind,
                kinds.map((k) => float(k.size)),
            ).mul(b.w.mul(0.4).add(0.8));
            const reachOut = isCentre.select(float(0), size.mul(0.62));
            const headPoint = head.center.add(GpuSplatMath.quatRotate(headTurn, vec3(reachOut, 0, 0)));

            const center = isStem.select(along.center, headPoint).toVar();
            const quaternion = isStem.select(alignY(along.tangent), headTurn);
            const far = clamp(length(center.sub(eye)).div(9), 1, 1.8);
            const scales = isStem.select(
                vec3(0.0035, height.div(stemSegments).mul(0.6), 0.0035),
                isCentre
                    .select(vec3(size.mul(0.26), 0.004, size.mul(0.26)), vec3(size.mul(0.42), 0.0015, size.mul(0.15)))
                    .mul(far),
            );

            // Colour, and light as the grass has it: sun unless a cloud's in the way,
            // the sky always, and through the petals towards the sun.
            const petalColour = pick(
                kind,
                kinds.map((k) => v3(k.petal)),
            );
            const centreColour = pick(
                kind,
                kinds.map((k) => v3(k.centre)),
            );
            const body = isStem.select(v3(FLOWERS.stem), isCentre.select(centreColour, petalColour));
            const lit = sunlight(center);
            const view = normalize(center.sub(eye));
            // Not too much: white petals glowing past the bloom threshold turn to halos.
            const through = pow(max(dot(view, sun), 0), 4).mul(isStem.select(float(0), float(0.3)));
            const faceSun = max(dot(facing, sun), 0).mul(0.5).add(0.5);
            const rgb = body.mul(v3(SUN).mul(faceSun.add(through)).mul(lit).mul(0.95).add(v3(SKYLIGHT).mul(0.5))).add(
                max(gust, 0)
                    .mul(0.05)
                    .mul(isStem.select(float(0), float(1))),
            );

            const finish = distance(center, out, rgb);
            const opacity = finish.opacity.mul(here).mul(isStem.select(float(1), float(FLOWERS.crisp)));
            return GpuSplats.Splat(center, scales, quaternion, finish.rgb.min(0.97), opacity, uint(index));
        },
        true,
    );
}

/* the butterflies */

/**
 * Butterflies over the flowers, in front of you. Each wanders on a smooth looping
 * path, bobbing up on its wingbeats, facing the way it flies. A body and four
 * wings hinged on it, beating gently, and often a glide with the wings
 * held up in a V. Wings are thin enough to glow with the sun behind them.
 */
const BUTTERFLIES = {
    count: 50,
    /** Where they gather (xz, metres from the middle, the way the shot looks) and how far they roam. */
    home: [-6, 5],
    roam: 9,
    /** How far each wanders from its own home, metres, and how fast it goes round. */
    wander: [2, 5],
    pace: [0.12, 0.3],
    /** Height over the ground, metres. */
    height: [0.55, 1.4],
    /** Wingbeats a second (slow enough not to alias into a buzz), and a wing's span from the body, metres. */
    flap: [3.5, 5.5],
    span: [0.026, 0.038],
    kinds: [
        { name: 'cabbage white', fore: [0.98, 0.97, 0.9], hind: [0.95, 0.95, 0.85] },
        { name: 'fritillary', fore: [0.98, 0.52, 0.1], hind: [0.85, 0.42, 0.09] },
        { name: 'common blue', fore: [0.42, 0.6, 1.0], hind: [0.5, 0.56, 0.92] },
        { name: 'brimstone', fore: [0.99, 0.93, 0.42], hind: [0.95, 0.88, 0.4] },
    ],
    body: [0.1, 0.08, 0.06],
};

function butterflies(): SplatObject {
    const parts = 5;
    const { kinds } = BUTTERFLIES;

    return generated(
        BUTTERFLIES.count * parts,
        (index) => {
            const fly = index.div(uint(parts));
            const part = float(index.mod(uint(parts))).toVar();
            const a = hash4(fly, 8).toVar();
            const b = hash4(fly, 9).toVar();
            const c = hash4(fly, 10).toVar();

            // Home, somewhere in the patch of meadow in front of you.
            const homeAngle = a.x.mul(Math.PI * 2);
            const home = vec2(BUTTERFLIES.home[0], BUTTERFLIES.home[1]).add(
                vec2(cos(homeAngle), sin(homeAngle)).mul(a.y.sqrt().mul(BUTTERFLIES.roam)),
            );

            // The path: two loops at unrelated rates, and its velocity, analytically.
            const r1 = mix(BUTTERFLIES.wander[0], BUTTERFLIES.wander[1], a.z);
            const r2 = r1.mul(0.45);
            const w1 = mix(BUTTERFLIES.pace[0], BUTTERFLIES.pace[1], a.w);
            const w2 = w1.mul(2.3);
            const p = b.xyzw.mul(Math.PI * 2);
            const t = time;
            const xz = home
                .add(
                    vec2(
                        sin(t.mul(w1).add(p.x))
                            .mul(r1)
                            .add(sin(t.mul(w2).add(p.y)).mul(r2)),
                        cos(t.mul(w1).add(p.z))
                            .mul(r1)
                            .add(cos(t.mul(w2).add(p.w)).mul(r2)),
                    ),
                )
                .toVar();
            const velocity = vec2(
                cos(t.mul(w1).add(p.x))
                    .mul(r1.mul(w1))
                    .add(cos(t.mul(w2).add(p.y)).mul(r2.mul(w2))),
                sin(t.mul(w1).add(p.z))
                    .mul(r1.mul(w1).negate())
                    .sub(sin(t.mul(w2).add(p.w)).mul(r2.mul(w2))),
            );
            const heading = atan(velocity.x, velocity.y);

            // Wingbeats, and now and then a glide with the wings held up.
            const rate = mix(BUTTERFLIES.flap[0], BUTTERFLIES.flap[1], c.x);
            const beat = sin(
                t
                    .mul(rate)
                    .mul(Math.PI * 2)
                    .add(c.y.mul(6.283)),
            );
            const glide = smoothstep(0.2, 0.6, sin(t.mul(0.45).add(c.z.mul(6.283))));
            const lift = mix(beat, float(0.35), glide);
            const wing = lift.mul(0.65).add(0.35);

            // Bobbing: a slow rise and fall, and a hitch upwards on each downbeat.
            const ground = terrain(xz).height;
            const cruise = mix(BUTTERFLIES.height[0], BUTTERFLIES.height[1], c.w);
            const bob = sin(t.mul(1.1).add(p.x)).mul(0.15).add(beat.mul(glide.oneMinus()).mul(0.012));
            const body = vec3(xz.x, ground.add(cruise).add(bob), xz.y).toVar();

            // Parts: 0 the body; 1, 2 the forewings; 3, 4 the hindwings.
            const isBody = part.equal(0);
            const side = part.mod(2).equal(1).select(float(1), float(-1));
            const isFore = part.lessThan(2.5);
            const span = mix(BUTTERFLIES.span[0], BUTTERFLIES.span[1], b.x).mul(isFore.select(float(1), float(0.8)));
            const facing = yaw(heading.mul(0.5));
            const roll = side.mul(wing).mul(0.5);
            const quaternion = isBody.select(facing, GpuSplatMath.quatMul(facing, vec4(0, 0, sin(roll), cos(roll)))).toVar();
            const reach = vec3(side.mul(span).mul(0.62), 0, isFore.select(span.mul(0.2), span.mul(-0.32)));
            const center = isBody.select(body, body.add(GpuSplatMath.quatRotate(quaternion, reach))).toVar();
            const scales = isBody.select(vec3(0.0025, 0.0025, span.mul(0.5)), vec3(span.mul(0.36), 0.001, span.mul(0.3)));

            // Colour and light: sun unless a cloud's in the way, the sky, and through
            // the wings towards the sun.
            const kind = c.x.add(c.w).fract().mul(kinds.length).floor();
            const fore = pick(
                kind,
                kinds.map((k) => v3(k.fore)),
            );
            const hind = pick(
                kind,
                kinds.map((k) => v3(k.hind)),
            );
            const colour = isBody.select(v3(BUTTERFLIES.body), isFore.select(fore, hind));
            const normal = GpuSplatMath.quatRotate(quaternion, vec3(0, 1, 0));
            const view = normalize(center.sub(eye));
            const through = pow(max(dot(view, sun), 0), 4).mul(isBody.select(float(0), float(0.8)));
            const lit = sunlight(center);
            const rgb = colour.mul(
                v3(SUN)
                    .mul(abs(dot(normal, sun)).mul(0.6).add(0.4).add(through))
                    .mul(lit)
                    .add(v3(SKYLIGHT).mul(0.5)),
            );

            const finish = distance(center, float(0), rgb);
            // Crisp, like the petals: each wing is one separate shape.
            return GpuSplats.Splat(center, scales, quaternion, finish.rgb.min(0.97), finish.opacity.mul(1.7), uint(index));
        },
        true,
    );
}

/* the ground */

function ground(): SplatObject {
    // Each splat covers about its share of the field, so they overlap into a floor.
    const share = Math.sqrt((Math.PI * FIELD.radius ** 2) / FIELD.ground);

    return generated(FIELD.ground, (index) => {
        const a = hash4(index, 0).toVar();
        const b = hash4(index, 1).toVar();
        const { xz, out } = scatter(a);
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

/** `clouds` is the cloud picture, already loaded: dark cloud on white. */
export function initField(clouds: THREE.Texture): Field {
    clouds.wrapS = clouds.wrapT = THREE.RepeatWrapping;
    clouds.colorSpace = THREE.NoColorSpace;
    cloudMap = clouds;
    return { objects: [ground(), blades(), flowers(), butterflies()] };
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
