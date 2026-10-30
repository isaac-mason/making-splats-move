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

export const SUN_DIRECTION = new THREE.Vector3(0.38, 0.225, -0.9).normalize();

export const HAZE = {
    cool: [0.5, 0.6, 0.72],
    warm: [1.0, 0.72, 0.46],
};

export const LIGHT = {
    sun: [1.0, 0.79, 0.56],
    strength: 1.35,
    /** From the sky above, onto tops and sides: the blue, cool against the sun. */
    sky: [0.17, 0.23, 0.36],
    /** From the land below, onto the base: dim, warm. */
    bounce: [0.1, 0.085, 0.065],
};

const FIELD = {
    grid: 10,
    cell: 175,
    base: 150,
    /** Where the fade into the horizon starts and is complete, metres. */
    fog: [260, 860],
    near: [6, 22],
};

const CLOUD = {
    splats: 10_000,
    domes: [0.4, 0.2, 0.2, 0.2],
    /** Footprint, metres, and height as a fraction of it. Wider than a cell, so neighbours merge. */
    width: [90, 175],
    tower: [0.42, 0.75],
    /** How hard the noise moves the surface, and the size of its biggest lumps, metres. */
    billow: 0.7,
    lump: 26,
    flat: 0.35,
    rise: 0.6,
    life: [120, 220],
    cut: [0.42, 0.06],
    soft: 0.08,
    base: 0.12,
    core: 0.15,
    extinction: 0.085,
    opacity: 0.7,
};

const MARCH = { fine: [5, 14], coarse: [30, 50, 70] };

const SCATTERING = { octaves: 4, fade: 0.5, thin: 0.45, spread: 0.5 };

const WIND = {
    speed: 4,
    angle: 0.4,
};

type Clock = { time: TslNode; drift: TslNode };
const makeClock = (): Clock => ({ time: uniform(0), drift: uniform(new THREE.Vector3()) });
const splatClock = makeClock();
const skyClock = makeClock();
const { time } = splatClock;
const eye = uniform(new THREE.Vector3());

/* helpers */

const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);
const sun = v3([SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z]);

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

export function hazeToward(dir: TslNode): TslNode {
    const towardSun = max(dot(normalize(vec3(dir.x, 0, dir.z).add(vec3(1e-5, 0, 0))), normalize(vec3(sun.x, 0, sun.z))), 0);
    return mix(v3(HAZE.cool), v3(HAZE.warm), pow(towardSun, 3).mul(0.85));
}

function wrap(xz: TslNode): TslNode {
    const span = FIELD.grid * FIELD.cell;
    return fract(xz.div(span).add(0.5)).sub(0.5).mul(span);
}

function phase(cosTheta: TslNode, g: number): TslNode {
    const denom = pow(float(1 + g * g).sub(cosTheta.mul(2 * g)), 1.5);
    return float(1 - g * g).div(denom);
}

/* the density field */

const inside = (p: TslNode, dome: TslNode): TslNode =>
    float(1).sub(length(vec3(p.x.sub(dome.x).div(dome.z), p.y.div(dome.w), p.z.sub(dome.y).div(dome.z))));

const envelopeAt = (p: TslNode, domes: TslNode[]): TslNode => domes.map((dome) => inside(p, dome)).reduce((a, b) => max(a, b));

const deepest = (p: TslNode, domes: TslNode[]): TslNode =>
    domes.reduce((best, dome) => inside(p, dome).greaterThan(inside(p, best)).select(dome, best));

function makeSurface(octaves: number) {
    return Fn(([p, d0, d1, d2, d3, height, cut, seed]: TslNode[]) => {
        const envelope = envelopeAt(p, [d0, d1, d2, d3]);

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

function normalAt(p: TslNode, sample: (at: TslNode) => TslNode): TslNode {
    const e = 1.5;
    const corners = [vec3(1, -1, -1), vec3(-1, -1, 1), vec3(-1, 1, -1), vec3(1, 1, 1)];
    const gradient = corners.map((k) => k.mul(sample(p.add(k.mul(e))))).reduce((a, b) => a.add(b));
    return normalize(gradient.negate().add(vec3(0, 1e-5, 0)));
}

const alignY = (dir: TslNode): TslNode => normalize(vec4(cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));

function onto(p: TslNode, surfaceValue: TslNode, target: TslNode, dome: TslNode): TslNode {
    const u = vec3(p.x.sub(dome.x).div(dome.z), p.y.div(dome.w), p.z.sub(dome.y).div(dome.z));
    const rho = max(length(u), 0.001);
    const moved = u.mul(max(rho.add(surfaceValue.sub(target)), 0).div(rho));
    return vec3(dome.x.add(moved.x.mul(dome.z)), max(moved.y.mul(dome.w), 0.4), dome.y.add(moved.z.mul(dome.z)));
}

/* where the clouds are */

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
        const byDome = (values: TslNode[]): TslNode =>
            values.reduce((picked, value, k) =>
                k === 0 ? value : within.greaterThanEqual(uint(firsts[k])).select(value, picked),
            );

        const { home, height, cut, domes, seed } = cloudLayout(cloud, splatClock, hash4);
        const xz = wrap(home.add(splatClock.drift.xz).sub(eye.xz)).add(eye.xz).toVar();

        const [d0, d1, d2, d3] = domes;
        const mine = byDome(domes).toVar();
        const splatsInMine = byDome(shares.map((n) => float(n)));

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

        const isBase = t.x.lessThan(CLOUD.base);
        const isCore = t.x.lessThan(CLOUD.base + CLOUD.core);
        const there = surfaceForLight(anywhere, d0, d1, d2, d3, height, cut, seed);
        const skin = onto(anywhere, there, t.y.mul(1.4).add(0.3).mul(CLOUD.soft), deepest(anywhere, domes));
        const disc = vec2(cos(theta), sin(theta)).mul(sqrt(s.z).mul(mine.z));
        const base = vec3(mine.x.add(disc.x), t.y.mul(1.2).add(0.4), mine.y.add(disc.y));
        const local = isBase.select(base, isCore.select(anywhere, skin)).toVar();
        const center = vec3(xz.x, FIELD.base, xz.y).add(local).toVar();

        const here = surface(local, d0, d1, d2, d3, height, cut, seed).toVar();
        const solid = densityOf(here, local);

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

        const lightSurface = (at: TslNode) => surfaceForLight(at, d0, d1, d2, d3, height, cut, seed);
        const normal = isBase.select(vec3(0, -1, 0), normalAt(local, lightSurface)).toVar();
        const isSkin = isBase.or(isCore).not();
        const scales = vec3(size, isCore.select(size, size.mul(isBase.select(0.3, CLOUD.flat))), size);
        const quaternion = isSkin.select(alignY(normal), vec4(0, 0, 0, 1));

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
        const facing = mix(0.35, 1.15, dot(normal, sun).mul(0.5).add(0.5));
        const shape = mix(float(1), facing, float(0.6).mul(backlit.oneMinus()));
        const direct = v3(LIGHT.sun).mul(scattered.mul(powder).mul(shape).mul(LIGHT.strength));

        const buried = clamp(envelopeAt(local, domes), 0, 1);
        const ambient = mix(v3(LIGHT.bounce), v3(LIGHT.sky), normal.y.mul(0.5).add(0.5)).mul(mix(1, 0.55, buried));

        const linear = clamp(direct.add(ambient), 0, 1);
        const lit = pow(linear, vec3(1 / 2.2));

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
