import {
    GpuSplats,
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
    Loop,
    cos,
    cross,
    dot,
    exp,
    float,
    hash,
    int,
    max,
    mix,
    mx_noise_float,
    mx_noise_vec3,
    normalize,
    sign,
    sin,
    smoothstep,
    sqrt,
    uint,
    uniform,
    uniformArray,
    vec3,
    vec4,
} = TSL;

/* settings */

const SHAPE = {
    dome: { centre: [0, 5.25, 0], radii: [5, 2.75, 5] },
    masses: 8,
    mass: { radius: [1.8, 2.3], clumps: [7, 10], clump: [0.38, 0.52] },
    trunk: { length: 1.9, radius: 0.42, lean: 0.12, flare: 1.3 },
    forks: 3,
    pieces: 4,
    gnarl: 0.16,
    pipe: 2.4,
};

const SPLATS = { sprays: 6000, bark: 9000 };
const HIDDEN_BARK = 0.15;

const LEAF = {
    length: 0.14,
    width: 0.08,
    thickness: 0.35,
    vary: 0.4,
    perSpray: 9,
    twig: [0.45, 0.8],
    parts: [
        { at: -0.2, length: 0.7, width: 1 },
        { at: 0.45, length: 0.5, width: 0.55 },
    ],
    opacity: 1.15,
    edge: 1.9,
};

const BARK = [0.07, 0.03, 0.012];

export const SUN_DIRECTION = new THREE.Vector3(0.85, 0.5, 0.15).normalize();

const WIND = {
    direction: new THREE.Vector3(1, 0, 0.35).normalize(),
    gust: { size: 14, speed: 4 },
    lean: 0.6,
    sway: { size: 0.25, rate: 0.3 },
    churn: { broad: [4, 0.18, 0.17], fine: [1.5, 0.35, 0.06] },
};

const THICKNESS = 0.55;

const PALETTE = {
    leaves: ['#2b5244', '#3a6d4a', '#4a8638', '#86b443', '#c8da6c'],
    steps: [0.04, 0.18, 0.36, 0.62, 0.95],
    bark: '#5a4a3c',
};

type V3 = [number, number, number];
type Segment = { a: V3; b: V3; ra: number; rb: number };
type Puff = { c: V3; r: number; mass: number; core: boolean };
type Mass = { c: V3; r: number };

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function grow(seed: number) {
    let s = seed;
    const random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const range = ([a, b]: readonly number[]) => a + (b - a) * random();
    const turn = (d: V3, angle: number, spin: number): V3 => {
        const side = unit(Math.abs(d[1]) < 0.9 ? crossV(d, [0, 1, 0]) : crossV(d, [1, 0, 0]));
        const other = crossV(d, side);
        const p = add(scale(side, Math.cos(spin)), scale(other, Math.sin(spin)));
        return unit(add(scale(d, Math.cos(angle)), scale(p, Math.sin(angle))));
    };

    const segments: Segment[] = [];
    const puffs: Puff[] = [];
    const branch = (start: V3, dir: V3, target: V3, r0: number, r1: number) => {
        let p = start;
        let d = dir;
        const n = SHAPE.pieces;
        const total = len(sub(target, start));
        for (let i = 0; i < n; i++) {
            d = unit(add(scale(d, 1 - (i + 1) / n), scale(unit(sub(target, p)), (i + 1) / n)));
            d = turn(d, SHAPE.gnarl * random(), random() * Math.PI * 2);
            const q = i === n - 1 ? target : add(p, scale(d, total / n));
            segments.push({ a: p, b: q, ra: r0 + ((r1 - r0) * i) / n, rb: r0 + ((r1 - r0) * (i + 1)) / n });
            p = q;
        }
        return { end: p, dir: d };
    };

    const centre = SHAPE.dome.centre as V3;
    const [rx, ry, rz] = SHAPE.dome.radii;
    const masses: Mass[] = [{ c: add(centre, [random() - 0.5, ry * 0.55, random() - 0.5]), r: SHAPE.mass.radius[1] }];
    const ring = SHAPE.masses - 1;
    const spin = random() * Math.PI * 2;
    for (let k = 0; k < ring; k++) {
        const a = spin + (k / ring) * Math.PI * 2 + (random() - 0.5) * 0.5;
        const tier = k % 2 ? 0.35 : -0.15;
        const out = 0.62 + random() * 0.12;
        masses.push({
            c: add(centre, [Math.cos(a) * rx * out, ry * (tier + (random() - 0.5) * 0.2), Math.sin(a) * rz * out]),
            r: range(SHAPE.mass.radius),
        });
    }

    const lean = turn([0, 1, 0], SHAPE.trunk.lean, random() * Math.PI * 2);
    const trunk = branch(
        [0, 0, 0],
        lean,
        scale(lean, SHAPE.trunk.length),
        SHAPE.trunk.radius * SHAPE.trunk.flare,
        SHAPE.trunk.radius * 0.8,
    );

    const forkRadius = SHAPE.trunk.radius * 0.8 * (1 / SHAPE.forks) ** (1 / SHAPE.pipe);
    const fork0 = random() * Math.PI * 2;
    const ways = Array.from({ length: SHAPE.forks }, (_, k) => fork0 + (k / SHAPE.forks) * Math.PI * 2 + (random() - 0.5) * 0.6);
    const shares: number[][] = ways.map(() => []);
    const apart = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    masses.forEach((m, i) => {
        const a = Math.atan2(m.c[2], m.c[0]);
        let best = 0;
        for (let k = 1; k < ways.length; k++) if (apart(a, ways[k]) < apart(a, ways[best])) best = k;
        shares[best].push(i);
    });
    for (const share of shares) {
        if (!share.length) continue;
        const middle = scale(
            share.reduce<V3>((sum, i) => add(sum, masses[i].c), [0, 0, 0]),
            1 / share.length,
        );
        const forkAt = add(trunk.end, scale(sub(middle, trunk.end), 0.45));
        const fork = branch(trunk.end, unit(add(sub(forkAt, trunk.end), [0, 2, 0])), forkAt, forkRadius, forkRadius * 0.8);
        const limbRadius = forkRadius * 0.8 * (1 / share.length) ** (1 / SHAPE.pipe);
        for (const i of share) {
            const m = masses[i];
            branch(fork.end, fork.dir, m.c, limbRadius, limbRadius * 0.5);
            puffs.push({ c: m.c, r: m.r * 0.8, mass: i, core: true });
            const clumps = Math.round(range(SHAPE.mass.clumps));
            for (let j = 0; j < clumps; j++) {
                const outward = unit(add(sub(m.c, centre), [0, 2, 0]));
                const dir = turn(outward, Math.acos(1 - random() * 1.4), random() * Math.PI * 2);
                const r = m.r * range(SHAPE.mass.clump);
                branch(m.c, dir, add(m.c, scale(dir, (m.r - r) * 0.8)), limbRadius * 0.4, limbRadius * 0.15);
                puffs.push({ c: add(m.c, scale(dir, m.r - r * 0.6)), r, mass: i, core: false });
            }
        }
    }
    return { segments, puffs, masses };
}

export type Placement = { seed: number; at: THREE.Vector3; size: number };

function growAt({ seed, at, size }: Placement) {
    const { segments, puffs, masses } = grow(seed);
    const place = (p: V3): V3 => add([at.x, at.y, at.z], scale(p, size));
    return {
        segments: segments.map((g) => ({ a: place(g.a), b: place(g.b), ra: g.ra * size, rb: g.rb * size })),
        puffs: puffs.map((p) => ({ ...p, c: place(p.c), r: p.r * size })),
        masses: masses.map((m) => ({ c: place(m.c), r: m.r * size })),
        dome: { centre: place(SHAPE.dome.centre as V3), radii: scale(SHAPE.dome.radii as V3, size) },
        foot: at.y,
        height: (SHAPE.dome.centre[1] + SHAPE.dome.radii[1]) * size,
    };
}
type Grown = ReturnType<typeof growAt>;

/* the shapes on the GPU */

function shapes(grown: Grown, counts: { sprays: number; bark: number }) {
    const { segments, puffs, masses, dome, foot, height } = grown;
    const v4 = (x: number, y: number, z: number, w: number) => new THREE.Vector4(x, y, z, w);
    const firsts = (weights: number[], total: number) => {
        const sum = weights.reduce((a, b) => a + b, 0);
        let at = 0;
        return weights.map((w) => {
            const first = Math.round(at);
            at += (w / sum) * total;
            return first;
        });
    };
    const hidden = (g: Segment) => {
        const middle = scale(add(g.a, g.b), 0.5);
        return puffs.some((p) => len(sub(middle, p.c)) < p.r * 0.9);
    };
    const barkFirst = firsts(
        segments.map((g) => (g.ra + g.rb) * len(sub(g.b, g.a)) * (hidden(g) ? HIDDEN_BARK : 1)),
        counts.bark,
    );
    const sprayFirst = firsts(
        puffs.map((p) => p.r ** 2 * (p.core ? 0.5 : 1)),
        counts.sprays,
    );
    return {
        dome,
        foot,
        height,
        segmentCount: segments.length,
        puffCount: puffs.length,
        segA: uniformArray(
            segments.map((g) => v4(...g.a, g.ra)),
            'vec4',
        ),
        segB: uniformArray(
            segments.map((g) => v4(...g.b, g.rb)),
            'vec4',
        ),
        segFirst: uniformArray(
            barkFirst.map((first) => v4(first, 0, 0, 0)),
            'vec4',
        ),
        puffA: uniformArray(
            puffs.map((p) => v4(...p.c, p.r)),
            'vec4',
        ),
        puffB: uniformArray(
            puffs.map((p, i) => v4(sprayFirst[i], p.mass, 0, 0)),
            'vec4',
        ),
        massA: uniformArray(
            masses.map((m) => v4(...m.c, m.r)),
            'vec4',
        ),
    };
}
type Shapes = ReturnType<typeof shapes>;

function whichRange(index: TslNode, count: number, first: (i: TslNode) => TslNode): TslNode {
    const lo = int(0).toVar();
    const hi = int(count).toVar();
    Loop(Math.ceil(Math.log2(count)) + 1, () => {
        const middle = lo.add(hi).div(2);
        If(first(middle).lessThanEqual(float(index)), () => {
            lo.assign(middle);
        }).Else(() => {
            hi.assign(middle);
        });
    });
    return lo;
}

/* light */

const sun = vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z);
const colour = (hex: string): TslNode => {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
};

function sunThrough(s: Shapes, p: TslNode, skip: TslNode): TslNode {
    const depth = float(0).toVar();
    Loop(s.puffCount, ({ i }: { i: TslNode }) => {
        const puff = s.puffA.element(i);
        const o = p.sub(puff.xyz);
        const b = dot(o, sun);
        const c = dot(o, o).sub(puff.w.mul(puff.w));
        const disc = b.mul(b).sub(c);
        If(disc.greaterThan(0).and(i.notEqual(skip)), () => {
            const root = sqrt(disc);
            depth.addAssign(max(root.sub(b), 0).sub(max(root.negate().sub(b), 0)));
        });
    });
    return exp(depth.mul(-THICKNESS));
}

function canopyNormal(s: Shapes, p: TslNode): TslNode {
    const [x, y, z] = s.dome.radii;
    return normalize(p.sub(vec3(...s.dome.centre)).div(vec3(x * x, y * y, z * z)));
}

/* splats */

type Layout = Record<string, 1 | 2 | 3 | 4>;
type Fields<L extends Layout> = { [K in keyof L]: TslNode };
type Instances<L extends Layout> = { read: (i: TslNode) => Fields<L>; kernel: WgpuCompute | null };

function instances<L extends Layout>(
    renderer: WebGPURenderer | null,
    label: string,
    count: number,
    layout: L,
    state: (i: TslNode) => Fields<L>,
): Instances<L> {
    if (!renderer) return { read: state, kernel: null };
    const slots: { key: keyof L; buffer: number; offset: number; size: number }[] = [];
    let buffer = 0;
    let offset = 0;
    for (const key of Object.keys(layout) as (keyof L)[]) {
        const size = layout[key];
        if (offset + size > 4) {
            buffer++;
            offset = 0;
        }
        slots.push({ key, buffer, offset, size });
        offset += size;
    }
    const buffers = Array.from({ length: buffer + 1 }, () => new WgpuBuffer({ renderer, format: 'float32x4', count }));
    const parts = (node: TslNode, size: number): TslNode[] =>
        size === 1 ? [node] : [...'xyzw'.slice(0, size)].map((c) => node[c]);
    const kernel = new WgpuCompute({
        label,
        body: ({ index }) => {
            If(index.lessThan(uint(count)), () => {
                const value = state(index);
                buffers.forEach((target, b) => {
                    const comps = slots.filter((slot) => slot.buffer === b).flatMap((slot) => parts(value[slot.key], slot.size));
                    while (comps.length < 4) comps.push(float(0));
                    target.element(index).assign(vec4(comps[0], comps[1], comps[2], comps[3]));
                });
            });
        },
    });
    const read = (i: TslNode): Fields<L> => {
        const packed = buffers.map((b) => b.element(i).toVar());
        const out = {} as Fields<L>;
        for (const slot of slots) out[slot.key] = packed[slot.buffer]['xyzw'.slice(slot.offset, slot.offset + slot.size)];
        return out;
    };
    return { read, kernel };
}

function quatFromBasis(x: TslNode, y: TslNode, z: TslNode): TslNode {
    const w = sqrt(max(x.x.add(y.y).add(z.z).add(1), 0)).mul(0.5);
    const qx = sqrt(max(x.x.sub(y.y).sub(z.z).add(1), 0))
        .mul(0.5)
        .mul(sign(y.z.sub(z.y)));
    const qy = sqrt(max(y.y.sub(x.x).sub(z.z).add(1), 0))
        .mul(0.5)
        .mul(sign(z.x.sub(x.z)));
    const qz = sqrt(max(z.z.sub(x.x).sub(y.y).add(1), 0))
        .mul(0.5)
        .mul(sign(x.y.sub(y.x)));
    return normalize(vec4(qx, qy, qz, w));
}

const sphereDir = (u: TslNode, v: TslNode): TslNode => {
    const z = u.mul(2).sub(1);
    const ring = sqrt(max(z.mul(z).oneMinus(), 0));
    const a = v.mul(Math.PI * 2);
    return vec3(cos(a).mul(ring), z, sin(a).mul(ring));
};

const across = (n: TslNode): TslNode =>
    normalize(
        cross(
            n,
            n.y
                .abs()
                .lessThan(0.95)
                .select(vec3(0, 1, 0), vec3(1, 0, 0)),
        ),
    );

const SPLAT_STATE = { at: 3, opacity: 1, quaternion: 4, scales: 3, rgb: 3 } as const;

function leafState(s: Shapes, index: TslNode) {
    const leaf = uint(index).div(uint(LEAF.parts.length));
    const part = uint(index).mod(uint(LEAF.parts.length));
    const spray = leaf.div(uint(LEAF.perSpray));
    const sh = (k: number) => hash(spray.mul(uint(17)).add(uint(k)));
    const h = (k: number) => hash(leaf.mul(uint(13)).add(uint(k)));
    const puff = whichRange(spray, s.puffCount, (i) => s.puffB.element(i).x).toVar();
    const p = s.puffA.element(puff).toVar();
    const mass = s.massA.element(int(s.puffB.element(puff).y)).toVar();

    const dir = vec3(0, 1, 0).toVar();
    const buried = float(1).toVar();
    Loop(6, ({ i }: { i: TslNode }) => {
        If(buried.greaterThan(0.5), () => {
            const tried = sphereDir(sh(0).add(float(i).mul(0.618)).fract(), sh(1).add(float(i).mul(0.414)).fract()).toVar();
            const at = p.xyz.add(tried.mul(p.w));
            const inside = float(0).toVar();
            Loop(s.puffCount, ({ i: j }: { i: TslNode }) => {
                const other = s.puffA.element(j);
                If(j.notEqual(puff).and(at.sub(other.xyz).length().lessThan(other.w.mul(0.95))), () => {
                    inside.assign(1);
                });
            });
            If(inside.lessThan(0.5), () => {
                dir.assign(tried);
                buried.assign(0);
            });
        });
    });

    const twigLength = mix(LEAF.twig[0], LEAF.twig[1], sh(2));
    const base = p.xyz.add(dir.mul(p.w.sub(twigLength.mul(0.55)))).toVar();
    const twig = normalize(dir.add(sphereDir(sh(3), sh(4)).mul(0.8))).toVar();
    const side = normalize(cross(twig, dir.add(vec3(0, 0.6, 0)))).toVar();
    const face = cross(side, twig);

    const shapeNormal = normalize(
        dir
            .mul(0.35)
            .add(normalize(base.sub(mass.xyz)).mul(0.3))
            .add(canopyNormal(s, base).mul(0.35)),
    );
    const clumpLight = max(dot(shapeNormal, sun).mul(0.65).add(0.45), 0).mul(sunThrough(s, base, puff));

    const j = float(leaf.mod(uint(LEAF.perSpray)));
    const t = j.add(0.5).div(LEAF.perSpray);
    const flank = j.mod(2).mul(2).sub(1);
    const size = t
        .mul(-0.4)
        .add(1.15)
        .mul(exp(h(0).sub(0.5).mul(LEAF.vary)));
    const lengthwise = normalize(twig.mul(t.mul(0.35).add(0.55)).add(side.mul(flank.mul(0.8)))).toVar();
    const tilt = normalize(face.add(sphereDir(h(1), h(2)).mul(0.5)));
    const facing = normalize(tilt.sub(lengthwise.mul(dot(tilt, lengthwise)))).toVar();
    // This part of the leaf: from the table, a select per part.
    const pick = (value: (q: (typeof LEAF.parts)[number]) => number): TslNode =>
        LEAF.parts.reduce<TslNode>(
            (picked, q, k) => (k === 0 ? float(value(q)) : part.equal(uint(k)).select(float(value(q)), picked)),
            float(0),
        );
    const along = pick((q) => q.at).add(0.9);
    const at = base.add(twig.mul(t.mul(twigLength))).add(lengthwise.mul(size.mul(along).mul(LEAF.length)));

    const light = clumpLight
        .mul(dot(facing, sun).abs().mul(0.2).add(0.7))
        .mul(t.mul(0.15).add(0.85))
        .add(facing.y.abs().mul(0.04).add(0.06))
        .add(h(3).mul(0.05));
    const [first, ...rest] = PALETTE.leaves.map(colour);
    const rgb = rest.reduce((c, next, k) => mix(c, next, smoothstep(PALETTE.steps[k], PALETTE.steps[k + 1], light)), first);

    return {
        at,
        opacity: buried.greaterThan(0.5).select(float(0), float(LEAF.opacity)),
        quaternion: quatFromBasis(lengthwise, cross(facing, lengthwise), facing),
        scales: vec3(
            pick((q) => q.length * LEAF.length),
            pick((q) => q.width * LEAF.width),
            pick((q) => q.width * LEAF.width * LEAF.thickness),
        ).mul(size.div(LEAF.edge)),
        rgb: rgb.mul(h(4).mul(0.12).add(0.94)),
    };
}

function barkState(s: Shapes, index: TslNode) {
    const h = (k: number) => hash(index.mul(uint(11)).add(uint(k)));
    const segment = whichRange(index, s.segmentCount, (i) => s.segFirst.element(i).x).toVar();
    const a = s.segA.element(segment).toVar();
    const b = s.segB.element(segment).toVar();

    const along = normalize(b.xyz.sub(a.xyz)).toVar();
    const side = across(along).toVar();
    const angle = h(0).mul(Math.PI * 2);
    const radial = side
        .mul(cos(angle))
        .add(cross(along, side).mul(sin(angle)))
        .toVar();
    const t = h(1);
    const at = mix(a.xyz, b.xyz, t)
        .add(radial.mul(mix(a.w, b.w, t)))
        .toVar();
    const quaternion = quatFromBasis(along, cross(radial, along), radial);

    // Lit by the sun where the canopy lets it through, never more than dimly under it.
    const light = max(dot(radial, sun), 0).mul(sunThrough(s, at, int(-1)));
    const rgb = colour(PALETTE.bark).mul(light.mul(0.9).add(0.25)).mul(h(2).mul(0.3).add(0.85));
    return {
        at,
        opacity: float(0.9),
        quaternion,
        scales: vec3(BARK[0], BARK[1], BARK[2]).mul(s.dome.radii[0] / SHAPE.dome.radii[0]),
        rgb,
    };
}

/* wind */

const time = uniform(0);
const windward = vec3(WIND.direction.x, 0, WIND.direction.z);

function gustAt(p: TslNode): TslNode {
    const travelled = p.xz.sub(windward.xz.mul(time.mul(WIND.gust.speed)));
    const n = mx_noise_float(vec3(travelled.div(WIND.gust.size), time.mul(0.05)));
    return smoothstep(-0.35, 0.45, n);
}

function windAt(s: Shapes, p: TslNode, gust: TslNode): TslNode {
    const up = p.y.sub(s.foot).div(s.height).clamp(0, 1.2);
    const bend = up.mul(up);
    const across = vec3(windward.z.negate(), 0, windward.x);
    const swing = sin(time.mul(WIND.sway.rate * Math.PI * 2).sub(p.y.mul(0.15)));
    const lean = windward.mul(gust.mul(WIND.lean).add(swing.mul(WIND.sway.size).mul(gust.mul(0.6).add(0.4))));
    const sideways = across.mul(sin(time.mul(WIND.sway.rate * Math.PI * 2 * 0.73).add(1.3)).mul(WIND.sway.size * 0.4));
    const churn = (size: number, rate: number, amount: number) =>
        mx_noise_vec3(p.div(size).add(vec3(time.mul(rate), time.mul(rate * 0.7), 0))).mul(amount);
    const stir = gust.mul(0.7).add(0.3).mul(up.mul(1.5).min(1));
    return lean
        .add(sideways)
        .mul(bend)
        .add(
            churn(WIND.churn.broad[0], WIND.churn.broad[1], WIND.churn.broad[2])
                .add(churn(WIND.churn.fine[0], WIND.churn.fine[1], WIND.churn.fine[2]))
                .mul(stir),
        );
}

function splats(s: Shapes, state: Instances<typeof SPLAT_STATE>, count: number, leaves: boolean): SplatObject {
    const generateSplat = (index: TslNode) => {
        const splat = state.read(index);
        const center = splat.at.add(windAt(s, splat.at, gustAt(splat.at)));
        return GpuSplats.Splat(center, splat.scales, splat.quaternion, splat.rgb, splat.opacity, uint(index));
    };
    return SplatCollection.object({ count, generator: { generateSplat }, ...(leaves ? { params: { lodInflate: false } } : {}) });
}

/* the tree, from the outside */

export type Tree = {
    objects: SplatObject[];
    centre: THREE.Vector3;
    /** How far its canopy spreads, metres. */
    spread: number;
};

export function initTree(renderer: WebGPURenderer, compute: boolean, placement: Placement): Tree {
    const grown = growAt(placement);
    const area = placement.size * placement.size;
    const counts = { sprays: Math.round(SPLATS.sprays * area), bark: Math.round(SPLATS.bark * area) };
    const leafCount = counts.sprays * LEAF.perSpray * LEAF.parts.length;
    const s = shapes(grown, counts);
    const gpu = compute ? renderer : null;
    const leaves = instances(gpu, 'leaves', leafCount, SPLAT_STATE, (i) => leafState(s, i));
    const bark = instances(gpu, 'bark', counts.bark, SPLAT_STATE, (i) => barkState(s, i));
    if (leaves.kernel && bark.kernel) {
        new WgpuComputeBatch(renderer).add(leaves.kernel, leafCount).add(bark.kernel, counts.bark).submit();
    }
    const [x, y, z] = grown.dome.centre;
    return {
        objects: [splats(s, bark, counts.bark, false), splats(s, leaves, leafCount, true)],
        centre: new THREE.Vector3(x, y - placement.size, z),
        spread: grown.dome.radii[0],
    };
}

export function updateTrees(elapsed: number): void {
    time.value = elapsed;
}
