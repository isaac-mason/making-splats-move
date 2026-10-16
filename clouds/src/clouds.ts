/**
 * The clouds: a sky of broken cumulus at golden hour, every splat generated on the
 * GPU from its index and the time. Nothing is stored. Also from here, for the sky:
 * the haze colour, and the shadow the same clouds cast on the land.
 *
 * A cloud is a density field. Its envelope is a few domes on one flat base, a big
 * one in the middle and smaller towers leaning off it; billowy noise then pushes
 * lumps out of that envelope: inverted Worley for the big round heads, |Perlin|
 * for the creases and knobbles on them, so the cauliflower is in the noise. The noise rises slowly
 * through the cloud, so the lumps roll upwards and boil. Each cloud lives on a
 * slow cycle, swelling and thinning away, so the sky is never quite the same.
 *
 * Splats go where they show. Most are on the skin: each starts anywhere in its
 * dome and takes one Newton step along the dome's radius onto the surface the
 * noise makes, landing a little way in, so a cloud's splats are small and spent on
 * its lumps rather than its hidden middle. Some lie flat across the base, which
 * the skin doesn't reach, and a few big ones fill the core so the skin never
 * shows daylight through. Each takes its opacity from the density where it lands.
 * Skin splats are discs lying along the surface's normal, so an edge seen side-on
 * is a crisp line rather than a blur.
 *
 * The light is marched. Every splat looks towards the sun through its own cloud,
 * a few short steps through the noise and two long ones through the bare envelope
 * to the far side, and keeps what gets through (Beer-Lambert), so sides away from
 * the sun, the base and the thick middles fall into the cloud's own shadow. On
 * top of that:
 * - multiple scattering, the cheap way: a few more, fainter copies of the sun
 *   through thinner cloud, less forward, so shadowed cloud glows rather than greys;
 * - a phase function, mostly forward, so edges glow silver when the sun is behind;
 * - the powder effect, thin sun-facing skins a touch darker than just inside them,
 *   which is what puts the shading into the creases;
 * - each lump shaded by which way its normal faces: the sun, the sky above, the
 *   land below, so lumps read one by one instead of melting into one white.
 * - blue skylight from above, a dim warm bounce from the land below, both dimmer deep in.
 */

import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';

const {
    Fn,
    abs,
    clamp,
    cos,
    cross,
    dot,
    exp,
    float,
    fract,
    length,
    max,
    mix,
    mx_noise_float,
    mx_worley_noise_float,
    normalize,
    pow,
    sin,
    smoothstep,
    sqrt,
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

/* the scene's numbers */

/** Towards the sun: golden hour, 13° up, so it sits in the view as you fly. */
export const SUN_DIRECTION = new THREE.Vector3(0.38, 0.225, -0.9).normalize();

/**
 * The haze at the horizon, linear: cool away from the sun, warm towards it. The
 * sky's horizon, what far clouds fade into and what far land fades into.
 */
export const HAZE = {
    cool: [0.5, 0.6, 0.72],
    warm: [1.0, 0.72, 0.46],
};

/** Light, linear. */
export const LIGHT = {
    sun: [1.0, 0.79, 0.56],
    /** Lower than one copy of the sun would want: the scattered copies add up. */
    strength: 1.35,
    /** From the sky above, onto tops and sides: the blue, cool against the sun. */
    sky: [0.17, 0.23, 0.36],
    /** From the land below, onto the base: dim, warm. */
    bounce: [0.1, 0.085, 0.065],
};

const FIELD = {
    /** Clouds sit one to a cell of a grid this many cells across, so they spread evenly. */
    grid: 10,
    cell: 175,
    /** The height of the cloud bases. */
    base: 150,
    /** Where the fade into the horizon starts and is complete, metres. */
    fog: [260, 860],
    /** Clouds this close to the camera fade out, metres: flying into one, as you can, is a wisp, not a wall. */
    near: [6, 22],
};

const CLOUD = {
    splats: 10_000,
    /**
     * Domes in a cloud's envelope, the first in the middle and the rest towers off
     * it, and each one's share of the splats: the middle one is the biggest.
     * Four: the density takes four.
     */
    domes: [0.4, 0.2, 0.2, 0.2],
    /** Footprint, metres, and height as a fraction of it. Wider than a cell, so neighbours merge. */
    width: [90, 175],
    tower: [0.42, 0.75],
    /** How hard the noise moves the surface, and the size of its biggest lumps, metres. */
    billow: 0.7,
    lump: 26,
    /** How thin a skin splat is, as a fraction of its width: discs lying on the surface. */
    flat: 0.35,
    /** How fast the lumps roll up through the cloud, m/s. */
    rise: 0.6,
    /** A cloud's life: seconds round, and how far its edge is eaten away at its thinnest and fullest. */
    life: [120, 220],
    cut: [0.42, 0.06],
    /** The edge's softness, in envelope units: thin, so the silver lining is too. */
    soft: 0.08,
    /**
     * What the splats are for. Most sit on the skin, pulled onto the surface the
     * noise makes, where every one of them shows. Some lie flat on the base, which
     * the skin doesn't cover. The rest fill the core, big, so the skin never shows
     * daylight through it.
     */
    base: 0.12,
    core: 0.15,
    /** Light lost per metre through solid cloud. */
    extinction: 0.085,
    /** A splat's opacity in solid cloud. */
    opacity: 0.7,
};

/**
 * Steps towards the sun, metres each: short first through the noise, where the
 * detail is, then long through the bare envelope, so a cloud's far side shades
 * its near one and thick clouds are darker than thin.
 */
const MARCH = { fine: [5, 14], coarse: [30, 50, 70] };

/**
 * Light that has scattered more than once, the cheap way: a few more copies of
 * the sun, each fainter, through thinner cloud, scattered less forward. It's what
 * lifts the shadowed side from dead grey to a soft glow.
 */
const SCATTERING = { octaves: 4, fade: 0.5, thin: 0.45, spread: 0.5 };

const WIND = {
    /** Drift, m/s, the way it blows in xz. */
    speed: 4,
    angle: 0.4,
};

/* uniforms, set once a frame */

/**
 * The clock the clouds keep: seconds, and how far the wind has carried them (an
 * xz vector held as a vec3, y unused: radix's generator shaders bind a vec2
 * uniform as a u32, which doesn't compile). The splats and the sky each get
 * their own uniforms, set together: a uniform shared between the two binds wrong.
 */
type Clock = { time: TslNode; drift: TslNode };
const makeClock = (): Clock => ({ time: uniform(0), drift: uniform(new THREE.Vector3()) });
const splatClock = makeClock();
const skyClock = makeClock();
const { time } = splatClock;
const eye = uniform(new THREE.Vector3());

/* helpers */

const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);
const sun = v3([SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z]);

/** Four hashes in [0, 1) of a seed. One per shader that uses it, named apart. */
const makeHash4 = (name: string) =>
    Fn(([i]: TslNode[]) => {
        const p = fract(vec3(i).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
        p.addAssign(dot(p, p.yzx.add(33.33)));
        const a = fract(p.xxy.add(p.yzz).mul(p.zyx));
        const w = fract(sin(i.mul(78.233)).mul(43758.5453));
        return vec4(a, w);
    }).setLayout({ name, type: 'vec4', inputs: [{ name: 'i', type: 'float' }] });
const hash4 = makeHash4('cloudHash');
const skyHash4 = makeHash4('cloudHashSky');

/** The haze towards a direction: warm towards the sun, cool away from it. */
export function hazeToward(dir: TslNode): TslNode {
    const towardSun = max(dot(normalize(vec3(dir.x, 0, dir.z).add(vec3(1e-5, 0, 0))), normalize(vec3(sun.x, 0, sun.z))), 0);
    return mix(v3(HAZE.cool), v3(HAZE.warm), pow(towardSun, 3).mul(0.85));
}

/** The field wraps around the camera, so clouds that drift off downwind come back upwind. */
function wrap(xz: TslNode): TslNode {
    const span = FIELD.grid * FIELD.cell;
    return fract(xz.div(span).add(0.5)).sub(0.5).mul(span);
}

/** Henyey-Greenstein, times 4π so that scattering the same every way is 1. */
function phase(cosTheta: TslNode, g: number): TslNode {
    const denom = pow(float(1 + g * g).sub(cosTheta.mul(2 * g)), 1.5);
    return float(1 - g * g).div(denom);
}

/* the density field */

/**
 * A dome on the base: its centre's xz offset from the cloud's, its radius and its
 * height. How far inside it a point is, 1 at the centre of its base, 0 on its skin.
 */
const inside = (p: TslNode, dome: TslNode): TslNode =>
    float(1).sub(length(vec3(p.x.sub(dome.x).div(dome.z), p.y.div(dome.w), p.z.sub(dome.y).div(dome.z))));

/** How far inside the envelope, the union of the domes, a point is. */
const envelopeAt = (p: TslNode, domes: TslNode[]): TslNode => domes.map((dome) => inside(p, dome)).reduce((a, b) => max(a, b));

/** The dome a point is deepest in. */
const deepest = (p: TslNode, domes: TslNode[]): TslNode =>
    domes.reduce((best, dome) => inside(p, dome).greaterThan(inside(p, best)).select(dome, best));

/**
 * The cloud's surface function at a point in its frame (metres, y up from its
 * base): positive inside, zero on the surface, in envelope units, so about one
 * per dome radius. `octaves` of billowy noise: the full set where the splats
 * sit, fewer for the light, which only needs the big shapes.
 */
function makeSurface(octaves: number) {
    return Fn(([p, d0, d1, d2, d3, height, cut, seed]: TslNode[]) => {
        const envelope = envelopeAt(p, [d0, d1, d2, d3]);

        // Billows, each octave about zero on average. The biggest is inverted Worley:
        // a round bump on every cell, the cauliflower heads. Smaller ones are |Perlin|,
        // creases and knobbles on the heads.
        const q = p
            .sub(vec3(0, time.mul(CLOUD.rise), 0))
            .div(CLOUD.lump)
            .add(seed);
        let billow: TslNode = float(1).sub(mx_worley_noise_float(q)).sub(0.5);
        let total = 1;
        for (let o = 1; o < octaves; o++) {
            const amp = 0.5 ** o;
            billow = billow.add(
                abs(mx_noise_float(q.mul(2.03 ** o).add(o * 7.31)))
                    .sub(0.25)
                    .mul(amp),
            );
            total += amp;
        }

        // Calmer low down, so the base stays flat and sharp.
        const h = p.y.div(height);
        return envelope
            .add(
                billow
                    .div(total)
                    .mul(CLOUD.billow)
                    .mul(smoothstep(0.0, 0.3, h)),
            )
            .sub(cut);
    }).setLayout({
        name: `cloudSurface${octaves}`,
        type: 'float',
        inputs: [
            { name: 'p', type: 'vec3' },
            { name: 'd0', type: 'vec4' },
            { name: 'd1', type: 'vec4' },
            { name: 'd2', type: 'vec4' },
            { name: 'd3', type: 'vec4' },
            { name: 'height', type: 'float' },
            { name: 'cut', type: 'float' },
            { name: 'seed', type: 'float' },
        ],
    });
}

const surface = makeSurface(3);
const surfaceForLight = makeSurface(2);

/** Density, 0 to 1, from the surface function: a thin ramp in, and a sharp flat base. */
const densityOf = (surfaceValue: TslNode, p: TslNode): TslNode =>
    smoothstep(0, CLOUD.soft, surfaceValue).mul(smoothstep(0, 1.5, p.y));

/**
 * The surface's outward normal at a point: the surface function's gradient from
 * four samples on a tetrahedron, as good as six on the axes. From the light's
 * octaves: the lumps, not the knobbles.
 */
function normalAt(p: TslNode, sample: (at: TslNode) => TslNode): TslNode {
    const e = 1.5;
    const corners = [vec3(1, -1, -1), vec3(-1, -1, 1), vec3(-1, 1, -1), vec3(1, 1, 1)];
    const gradient = corners.map((k) => k.mul(sample(p.add(k.mul(e))))).reduce((a, b) => a.add(b));
    return normalize(gradient.negate().add(vec3(0, 1e-5, 0)));
}

/** Shortest-arc rotation taking +Y onto `dir`. */
const alignY = (dir: TslNode): TslNode => normalize(vec4(cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));

/**
 * Move a point along its dome's radius until the surface function there would
 * be `target`, assuming the noise holds still: a Newton step, since the envelope
 * falls by one per dome radius. Lands within a metre or two of the noisy surface.
 */
function onto(p: TslNode, surfaceValue: TslNode, target: TslNode, dome: TslNode): TslNode {
    const u = vec3(p.x.sub(dome.x).div(dome.z), p.y.div(dome.w), p.z.sub(dome.y).div(dome.z));
    const rho = max(length(u), 0.001);
    const moved = u.mul(max(rho.add(surfaceValue.sub(target)), 0).div(rho));
    return vec3(dome.x.add(moved.x.mul(dome.z)), max(moved.y.mul(dome.w), 0.4), dome.y.add(moved.z.mul(dome.z)));
}

/* where the clouds are */

/**
 * Cloud number `cloud`: where it lives in the field (before the drift and the
 * wrap), how big, how far into its life, and its domes. The same for the splats
 * and for the shadows on the land, from the same hash, so the two agree.
 */
function cloudLayout(cloud: TslNode, clock: Clock, hash: typeof hash4) {
    const c = hash(cloud.mul(3.17).add(1.3)).toVar();
    const cellXZ = vec2(cloud.mod(FIELD.grid), cloud.div(FIELD.grid).floor());
    const home = cellXZ.add(vec2(c.x, c.y).mul(0.7).add(0.15)).mul(FIELD.cell);
    const width = mix(CLOUD.width[0], CLOUD.width[1], pow(c.z, 1.4)).toVar();
    const height = width.mul(mix(CLOUD.tower[0], CLOUD.tower[1], c.w)).toVar();
    const period = mix(CLOUD.life[0], CLOUD.life[1], fract(c.x.mul(7.7)));
    const life = sin(
        clock.time
            .div(period)
            .mul(Math.PI * 2)
            .add(c.y.mul(40)),
    )
        .mul(0.5)
        .add(0.5);
    const cut = mix(CLOUD.cut[0], CLOUD.cut[1], smoothstep(0, 1, life)).toVar();

    // The domes: the middle one big and full height, towers off it smaller and lower.
    const domes: TslNode[] = [vec4(0, 0, width.mul(0.5), height).toVar()];
    for (let k = 1; k < CLOUD.domes.length; k++) {
        const d = hash(cloud.mul(5.9).add(k * 13.1)).toVar();
        const angle = d.x.mul(Math.PI * 2);
        const out = mix(0.2, 0.42, d.y).mul(width);
        domes.push(
            vec4(
                cos(angle).mul(out),
                sin(angle).mul(out),
                mix(0.24, 0.36, d.z).mul(width),
                mix(0.45, 0.8, d.w).mul(height),
            ).toVar(),
        );
    }
    return { home, width, height, cut, domes, seed: cloud.mul(17.3) };
}

/**
 * How much cloud is overhead along the sun's ray from a point on the land, 0 to 1:
 * the cloud layer seen from below as discs, one per dome, at half the cloud's
 * height. Looks at the cell the ray comes through and its eight neighbours, as
 * clouds are wider than a cell. The field wraps round the point, not the camera,
 * so shadows run on to the horizon.
 */
export function cloudShadow(ground: TslNode): TslNode {
    const overhead = ground.xz
        .add(
            sun.xz.mul(
                float(FIELD.base + 45)
                    .sub(ground.y)
                    .div(sun.y),
            ),
        )
        .toVar();
    const cell = overhead.sub(skyClock.drift.xz).div(FIELD.cell).floor().toVar();
    let cover: TslNode = float(0);
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            // Wrapped into the grid by hand: WGSL's % keeps the sign of a negative.
            const raw = cell.add(vec2(dx, dz));
            const at = raw.sub(raw.div(FIELD.grid).floor().mul(FIELD.grid));
            const cloud = at.x.add(at.y.mul(FIELD.grid));
            const { home, cut, domes } = cloudLayout(cloud, skyClock, skyHash4);
            const xz = wrap(home.add(skyClock.drift.xz).sub(overhead)).add(overhead);
            const offset = overhead.sub(xz);
            const inside = domes
                .map((dome) => float(1).sub(length(offset.sub(dome.xy).div(dome.z)).mul(1.1)))
                .reduce((a, b) => max(a, b));
            // Soft-edged: a shadow cast from 150 m up blurs, and a hard disc reads as a stain.
            cover = max(cover, smoothstep(cut.sub(0.15), cut.add(0.35), inside));
        }
    }
    return cover;
}

/* the clouds */

function cumulus(): SplatObject {
    const clouds = FIELD.grid * FIELD.grid;
    const shares = CLOUD.domes.map((share) => Math.floor(share * CLOUD.splats));
    const firsts = shares.map((_, k) => shares.slice(0, k).reduce((a, b) => a + b, 0));

    const generateSplat = (index: TslNode) => {
        const cloud = float(index.div(uint(CLOUD.splats)));
        const within = index.mod(uint(CLOUD.splats));
        /** Pick the dome this splat is in: the last one whose first splat it's past. */
        const byDome = (values: TslNode[]): TslNode =>
            values.reduce((picked, value, k) =>
                k === 0 ? value : within.greaterThanEqual(uint(firsts[k])).select(value, picked),
            );

        // The cloud, and where it is now: drifted, and wrapped round the camera.
        const { home, height, cut, domes, seed } = cloudLayout(cloud, splatClock, hash4);
        const xz = wrap(home.add(splatClock.drift.xz).sub(eye.xz)).add(eye.xz).toVar();

        const [d0, d1, d2, d3] = domes;
        const mine = byDome(domes).toVar();
        const splatsInMine = byDome(shares.map((n) => float(n)));

        // The splat: first anywhere in its dome, evenly by volume.
        const s = hash4(float(index).mul(0.731).add(5.1)).toVar();
        const t = hash4(float(index).mul(1.913).add(2.7)).toVar();
        const cosPhi = s.x;
        const sinPhi = sqrt(float(1).sub(cosPhi.mul(cosPhi)));
        const theta = s.y.mul(Math.PI * 2);
        const r = pow(s.z, 1 / 3);
        const anywhere = vec3(
            mine.x.add(mine.z.mul(r).mul(sinPhi).mul(cos(theta))),
            mine.w.mul(r).mul(cosPhi),
            mine.y.add(mine.z.mul(r).mul(sinPhi).mul(sin(theta))),
        ).toVar();

        // Then by role. On the skin: pulled onto the surface, a little way in.
        const isBase = t.x.lessThan(CLOUD.base);
        const isCore = t.x.lessThan(CLOUD.base + CLOUD.core);
        const there = surfaceForLight(anywhere, d0, d1, d2, d3, height, cut, seed);
        const skin = onto(anywhere, there, t.y.mul(1.4).add(0.3).mul(CLOUD.soft), deepest(anywhere, domes));
        // On the base: across the dome's footprint, just above it.
        const disc = vec2(cos(theta), sin(theta)).mul(sqrt(s.z).mul(mine.z));
        const base = vec3(mine.x.add(disc.x), t.y.mul(1.2).add(0.4), mine.y.add(disc.y));
        const local = isBase.select(base, isCore.select(anywhere, skin)).toVar();
        const center = vec3(xz.x, FIELD.base, xz.y).add(local).toVar();

        const here = surface(local, d0, d1, d2, d3, height, cut, seed).toVar();
        const solid = densityOf(here, local);

        // Each the size of its share of what its role covers, a little more, so they melt together.
        const area = mine.z.mul(mine.z.add(mine.w)).mul(Math.PI);
        const footprint = mine.z.mul(mine.z).mul(Math.PI);
        const volume = mine.z
            .mul(mine.z)
            .mul(mine.w)
            .mul((2 / 3) * Math.PI);
        const skinSize = sqrt(area.div(splatsInMine.mul(1 - CLOUD.base - CLOUD.core))).mul(0.65);
        const baseSize = sqrt(footprint.div(splatsInMine.mul(CLOUD.base))).mul(0.7);
        const coreSize = pow(volume.div(splatsInMine.mul(CLOUD.core)), 1 / 3).mul(0.75);
        const size = isBase.select(baseSize, isCore.select(coreSize, skinSize)).mul(s.w.mul(0.3).add(0.75)).toVar();

        // Skin splats are discs lying on the surface, so an edge seen side-on is a
        // crisp line, not a blur; base ones lie flat on the base; core ones are round.
        const lightSurface = (at: TslNode) => surfaceForLight(at, d0, d1, d2, d3, height, cut, seed);
        const normal = isBase.select(vec3(0, -1, 0), normalAt(local, lightSurface)).toVar();
        const isSkin = isBase.or(isCore).not();
        const scales = vec3(size, isCore.select(size, size.mul(isBase.select(0.3, CLOUD.flat))), size);
        const quaternion = isSkin.select(alignY(normal), vec4(0, 0, 0, 1));

        // Sunlight through the cloud: through the noise near, through the bare envelope far.
        const depth = float(0).toVar();
        let along = 0;
        for (const step of MARCH.fine) {
            along += step;
            const at = local.add(sun.mul(along - step / 2));
            depth.addAssign(densityOf(lightSurface(at), at).mul(step * CLOUD.extinction));
        }
        for (const step of MARCH.coarse) {
            along += step;
            const at = local.add(sun.mul(along - step / 2));
            depth.addAssign(densityOf(envelopeAt(at, domes).sub(cut), at).mul(step * CLOUD.extinction));
        }

        const view = normalize(center.sub(eye));
        const cosTheta = dot(view, sun);
        let scattered: TslNode = float(0);
        for (let i = 0; i < SCATTERING.octaves; i++) {
            const lobe = mix(phase(cosTheta, -0.15), phase(cosTheta, 0.6 * SCATTERING.spread ** i), 0.3);
            scattered = scattered.add(
                exp(depth.mul(-(SCATTERING.thin ** i)))
                    .mul(lobe)
                    .mul(SCATTERING.fade ** i),
            );
        }
        const backlit = smoothstep(0.3, 1, cosTheta);
        const powder = mix(mix(0.6, 1, float(1).sub(exp(depth.mul(-2.5)))), 1, backlit);
        // Each lump shaded by which way it faces: towards the sun brighter, away
        // darker, except backlit, where the edges are meant to glow.
        const facing = mix(0.35, 1.15, dot(normal, sun).mul(0.5).add(0.5));
        const shape = mix(float(1), facing, float(0.6).mul(backlit.oneMinus()));
        const direct = v3(LIGHT.sun).mul(scattered.mul(powder).mul(shape).mul(LIGHT.strength));

        // The sky lights what faces up, the land what faces down.
        const buried = clamp(envelopeAt(local, domes), 0, 1);
        const ambient = mix(v3(LIGHT.bounce), v3(LIGHT.sky), normal.y.mul(0.5).add(0.5)).mul(mix(1, 0.55, buried));

        const linear = clamp(direct.add(ambient), 0, 1);
        const lit = pow(linear, vec3(1 / 2.2));

        // Far clouds fade into the horizon, and out at the edge of the field.
        const far = length(center.xz.sub(eye.xz));
        const fog = smoothstep(FIELD.fog[0], FIELD.fog[1], far);
        const edge = smoothstep(FIELD.grid * FIELD.cell * 0.5, FIELD.grid * FIELD.cell * 0.42, far);
        const near = smoothstep(FIELD.near[0], FIELD.near[1], length(center.sub(eye)));
        const opacity = solid.mul(CLOUD.opacity).mul(edge).mul(near);

        return GpuSplats.Splat(
            center,
            scales,
            quaternion,
            mix(lit, pow(hazeToward(view), vec3(1 / 2.2)), fog.mul(0.8)),
            opacity,
            uint(index),
        );
    };

    return SplatCollection.object({ count: clouds * CLOUD.splats, generator: { generateSplat } });
}

/* the sky's contents */

export type Clouds = { objects: SplatObject[] };

export function initClouds(): Clouds {
    return { objects: [cumulus()] };
}

export function updateClouds(elapsed: number, dt: number, camera: THREE.Camera): void {
    for (const clock of [splatClock, skyClock]) clock.time.value = elapsed;
    eye.value.copy(camera.position);
    for (const clock of [splatClock, skyClock]) {
        clock.drift.value.x += Math.cos(WIND.angle) * WIND.speed * dt;
        clock.drift.value.z += Math.sin(WIND.angle) * WIND.speed * dt;
    }
}
