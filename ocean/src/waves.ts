/**
 * The waves: Tessendorf's FFT ocean, the way film and games (Sea of Thieves,
 * Crest) make a sea. A wind-wave spectrum is laid out once over a grid of
 * wavenumbers; every frame each wave's phase is turned on by its own speed (deep
 * water, ω² = gk), and an inverse FFT on the GPU turns the lot into the sea's
 * surface over a square tile. Three tiles, three sizes, so it holds from the long
 * rolls down to the chop with no pattern repeating where you'd see it.
 *
 * For each tile, one FFT gives everything the sea needs, packed two real fields
 * to a complex one:
 * - its height, and its sideways chop (Dx, Dz): the crests pulled together and
 *   the troughs spread, sharp crests and wide troughs, the Sea of Thieves look;
 * - its slope, for the light;
 * - how the chop squeezes the surface (∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z): where it
 *   squeezes it to nothing, a crest's pinching over and breaking, and that's
 *   where the whitecaps are.
 * Each tile's written to two textures the sea samples with the hardware's
 * filtering, wrapping round.
 *
 * The spectrum is JONSWAP for a moderate gale over a long fetch, spread round the
 * wind; each tile keeps only its own band of wavelengths, so they don't double
 * up. A probe samples the surface where the boat feels it, on the GPU, and reads
 * it back a frame or two late, so the boat floats on the very waves drawn.
 *
 * WebGPU only.
 *
 * Sections: settings · the spectrum · the FFT · the probe · reading the waves.
 */

import { TSL, type TslNode, WgpuBuffer, WgpuCompute, WgpuComputeBatch } from 'spark-radix';
import * as THREE from 'three';
import { StorageTexture, type WebGPURenderer } from 'three/webgpu';

const { If, cos, float, int, sin, sqrt, texture, textureStore, uint, uniform, uvec2, vec2, vec3, vec4 } = TSL;

/* settings */

/** Texels across each tile (a power of two). */
export const TEXELS = 256;
const N = TEXELS;

/**
 * The tiles: how big each is (metres), and the shortest wave the one before it
 * leaves to it, as a multiple of its own longest-but-one (so each wavelength's in
 * exactly one tile).
 */
const TILES = [400, 61, 8.3];
const HAND_OVER = 6;

/**
 * The wind and the sea it raises: its speed (m/s), how far it's blown over open
 * water (metres, the fetch), which way (radians round from +x towards +z), how
 * peaked the spectrum is (JONSWAP's γ) and how narrowly the waves follow the
 * wind (the spreading's power). The waves overall a touch taller or calmer than
 * the spectrum says, how much their chop pulls the crests together, and the
 * shortest ripple kept (metres).
 */
export const SEA = { wind: 10, fetch: 120000, towards: -2.2, peaked: 3.3, follow: 6, height: 0.7, chop: 0.85, finest: 0.02 };

/** Gravity, m/s². */
const GRAVITY = 9.81;

/* the spectrum */

/** A seeded random stream: uniform 0..1, and normal. */
function random(seed: number) {
    let state = seed >>> 0;
    const next = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return (state + 0.5) / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
    return { next, normal };
}

/** The JONSWAP spectrum: how much of the sea's height variance is at angular frequency ω (m²·s). */
function jonswap(omega: number): number {
    const { wind, fetch, peaked } = SEA;
    const alpha = 0.076 * ((wind * wind) / (fetch * GRAVITY)) ** 0.22;
    const peak = 22 * ((GRAVITY * GRAVITY) / (wind * fetch)) ** (1 / 3);
    const sigma = omega <= peak ? 0.07 : 0.09;
    const r = Math.exp(-((omega - peak) ** 2) / (2 * sigma * sigma * peak * peak));
    return ((alpha * GRAVITY * GRAVITY) / omega ** 5) * Math.exp(-1.25 * (peak / omega) ** 4) * peaked ** r;
}

/** How much of the sea runs at angle θ off the wind: cos²ˢ of half the angle, normalised round the circle. */
const spreading = (() => {
    const s = SEA.follow;
    let total = 0;
    for (let i = 0; i < 720; i++) total += Math.cos(((i + 0.5) / 720) * Math.PI - Math.PI / 2) ** (2 * s);
    const norm = 1 / ((total / 720) * 2 * Math.PI);
    return (theta: number) => norm * Math.abs(Math.cos(theta / 2)) ** (2 * s);
})();

/**
 * Each tile's starting waves, h₀(k), and the conjugate of h₀(−k) beside it: random
 * phases and heights drawn from the spectrum, only for its band of wavelengths.
 * Laid out with k = (i − N/2, j − N/2) · 2π/L. Also the rms slope it holds.
 */
function startingWaves(tile: number, seed: number): { data: Float32Array; slope: number } {
    const L = TILES[tile];
    const dk = (2 * Math.PI) / L;
    const lowest = tile === 0 ? 0 : HAND_OVER * dk;
    const highest = tile === TILES.length - 1 ? Number.POSITIVE_INFINITY : HAND_OVER * ((2 * Math.PI) / TILES[tile + 1]);
    const { normal } = random(seed);
    const h0 = new Float32Array(N * N * 2);
    let variance = 0;
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const kx = (i - N / 2) * dk;
            const kz = (j - N / 2) * dk;
            const k = Math.hypot(kx, kz);
            const o = (j * N + i) * 2;
            if (k < 1e-6 || k < lowest || k >= highest) continue;
            const omega = Math.sqrt(GRAVITY * k);
            // From frequency to wavenumber: S(k) = S(ω) dω/dk / k, dω/dk = g / 2ω.
            const theta = Math.atan2(kz, kx) - SEA.towards;
            const density = ((jonswap(omega) * GRAVITY) / (2 * omega) / k) * spreading(theta);
            const fine = Math.exp(-(k * k) * SEA.finest * SEA.finest);
            const amplitude = Math.sqrt((density * dk * dk) / 2) * fine * SEA.height;
            h0[o] = normal() * amplitude;
            h0[o + 1] = normal() * amplitude;
            variance += amplitude * amplitude * 2 * k * k;
        }
    }
    // Beside each, the conjugate of the wave going the other way.
    const data = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const o = (j * N + i) * 2;
            const oi = (N - i) % N;
            const oj = (N - j) % N;
            const om = (oj * N + oi) * 2;
            data.set([h0[o], h0[o + 1], h0[om], -h0[om + 1]], (j * N + i) * 4);
        }
    }
    return { data, slope: Math.sqrt(variance / 2) };
}

/* the FFT */

const TILE_TEXELS = N * N;
const ALL = TILES.length * TILE_TEXELS;
const STAGES = Math.log2(N);

/** a × b, complex. */
const times = (a: TslNode, b: TslNode): TslNode => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));
/** a × i, complex. */
const timesI = (a: TslNode): TslNode => vec2(a.y.negate(), a.x);

export type Waves = {
    /** Each tile's textures: (Dx, height, Dz, ∂Dx/∂z) and (slope x, slope z, ∂Dx/∂x, ∂Dz/∂z), and its size (metres). */
    tiles: { shape: StorageTexture; slope: StorageTexture; size: number; slope_rms: number }[];
    /** Step the sea on to `elapsed` seconds. */
    update: (elapsed: number) => void;
    /** Where the boat feels the water: its heights at these points (x, z), a frame or two late. */
    probe: (points: [number, number][]) => number[];
};

const MAX_PROBES = 8;

/**
 * The probe's heights arrive late, so they're carried on at the rate they were
 * changing: no faster than this (m/s), and no further ahead than this (seconds).
 */
const PROBE = { fastest: 4, ahead: 0.15 };

export function initWaves(renderer: WebGPURenderer): Waves {
    const time = uniform(0);

    const start = new WgpuBuffer({ renderer, format: 'float32x4', count: ALL });
    const startData = new Float32Array(ALL * 4);
    const slopes: number[] = [];
    TILES.forEach((_, tile) => {
        const { data, slope } = startingWaves(tile, 1234 + tile * 7919);
        startData.set(data, tile * TILE_TEXELS * 4);
        slopes.push(slope);
    });
    start.attribute.array.set(startData);
    start.attribute.needsUpdate = true;

    // Two ping-pong pairs: four complex fields, two to a vec4.
    const a = [0, 1].map(() => new WgpuBuffer({ renderer, format: 'float32x4', count: ALL }));
    const b = [0, 1].map(() => new WgpuBuffer({ renderer, format: 'float32x4', count: ALL }));

    /** The tile, its column and row, from a texel's index over them all. */
    const where = (index: TslNode) => {
        const tile = index.div(uint(TILE_TEXELS));
        const rest = index.mod(uint(TILE_TEXELS));
        return { tile, i: rest.mod(uint(N)), j: rest.div(uint(N)) };
    };
    const dkOf = (tile: TslNode): TslNode =>
        TILES.reduce<TslNode>((acc, L, t) => tile.equal(uint(t)).select(float((2 * Math.PI) / L), acc), float(0));

    // Each frame's spectrum: every wave turned on by its own speed, and from it the chop,
    // the slopes and the squeeze, packed two real fields to a complex one.
    const spectrum = new WgpuCompute({
        label: 'oceanSpectrum',
        body: ({ index }) => {
            If(index.lessThan(uint(ALL)), () => {
                const { tile, i, j } = where(index);
                const dk = dkOf(tile);
                const k = vec2(float(int(i).sub(N / 2)), float(int(j).sub(N / 2)))
                    .mul(dk)
                    .toVar();
                const length = k.length().max(1e-6).toVar();
                const omega = sqrt(length.mul(GRAVITY));
                const s = start.element(index).toVar();
                const turn = vec2(cos(omega.mul(time)), sin(omega.mul(time))).toVar();
                const h = times(s.xy, turn)
                    .add(times(s.zw, vec2(turn.x, turn.y.negate())))
                    .toVar();
                // Dx = −i kx/|k| h, Dz = −i kz/|k| h; slopes i kx h, i kz h; and the squeeze:
                // ∂Dx/∂x = kx²/|k| h, ∂Dz/∂z = kz²/|k| h, ∂Dx/∂z = kx kz/|k| h.
                const dx = timesI(h).mul(k.x.div(length).negate());
                const dz = timesI(h).mul(k.y.div(length).negate());
                const sx = timesI(h).mul(k.x);
                const sz = timesI(h).mul(k.y);
                const dxx = h.mul(k.x.mul(k.x).div(length));
                const dzz = h.mul(k.y.mul(k.y).div(length));
                const dxz = h.mul(k.x.mul(k.y).div(length));
                // Two real fields packed as one complex: A + iB.
                const pack = (p: TslNode, q: TslNode) => p.add(timesI(q));
                a[0].element(index).assign(vec4(pack(h, dx), pack(dz, sx)));
                b[0].element(index).assign(vec4(pack(sz, dxx), pack(dzz, dxz)));
            });
        },
    });

    // The inverse FFT, Stockham radix-2: rows then columns, one stage a pass, ping-ponging.
    const stage = (step: number, along: 'rows' | 'columns', from: number) =>
        new WgpuCompute({
            label: `oceanFft${along}${step}`,
            body: ({ index }) => {
                If(index.lessThan(uint(ALL / 2)), () => {
                    const tile = index.div(uint(TILE_TEXELS / 2));
                    const rest = index.mod(uint(TILE_TEXELS / 2));
                    const line = rest.div(uint(N / 2));
                    const t = rest.mod(uint(N / 2));
                    const half = 2 ** step;
                    const k = t.mod(uint(half));
                    const out = t.sub(k).mul(2).add(k);
                    const at = (p: TslNode) =>
                        along === 'rows'
                            ? tile
                                  .mul(uint(TILE_TEXELS))
                                  .add(line.mul(uint(N)))
                                  .add(p)
                            : tile
                                  .mul(uint(TILE_TEXELS))
                                  .add(p.mul(uint(N)))
                                  .add(line);
                    const angle = float(k).mul(Math.PI / half);
                    const w = vec2(cos(angle), sin(angle)).toVar();
                    for (const pair of [a, b]) {
                        const x0 = pair[from].element(at(t)).toVar();
                        const x1 = pair[from].element(at(t.add(uint(N / 2)))).toVar();
                        const w0 = times(w, x1.xy);
                        const w1 = times(w, x1.zw);
                        pair[1 - from].element(at(out)).assign(vec4(x0.xy.add(w0), x0.zw.add(w1)));
                        pair[1 - from].element(at(out.add(uint(half)))).assign(vec4(x0.xy.sub(w0), x0.zw.sub(w1)));
                    }
                });
            },
        });
    const stages: WgpuCompute[] = [];
    for (const along of ['rows', 'columns'] as const)
        for (let s = 0; s < STAGES; s++) stages.push(stage(s, along, stages.length % 2));
    const result = stages.length % 2;

    // Each tile's textures, unpacked from the FFT (undoing the centred k's alternating sign).
    const tiles = TILES.map((size, tile) => {
        const make = () => {
            const t = new StorageTexture(N, N);
            t.type = THREE.HalfFloatType;
            t.format = THREE.RGBAFormat;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.magFilter = THREE.LinearFilter;
            t.minFilter = THREE.LinearFilter;
            t.generateMipmaps = false;
            return t;
        };
        return { shape: make(), slope: make(), size, slope_rms: slopes[tile] };
    });
    const unpack = tiles.map(
        (target, tile) =>
            new WgpuCompute({
                label: `oceanUnpack${tile}`,
                body: ({ index }) => {
                    If(index.lessThan(uint(TILE_TEXELS)), () => {
                        const i = index.mod(uint(N));
                        const j = index.div(uint(N));
                        const at = index.add(uint(tile * TILE_TEXELS));
                        const sign = float(i.add(j).mod(uint(2)))
                            .mul(-2)
                            .add(1);
                        const p = a[result].element(at).mul(sign).toVar();
                        const q = b[result].element(at).mul(sign).toVar();
                        // p: (height, Dx, Dz, slope x); q: (slope z, ∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z).
                        const chop = SEA.chop;
                        textureStore(
                            target.shape,
                            uvec2(i, j),
                            vec4(p.y.mul(chop), p.x, p.z.mul(chop), q.w.mul(chop)),
                        ).toWriteOnly();
                        textureStore(target.slope, uvec2(i, j), vec4(p.w, q.x, q.y.mul(chop), q.z.mul(chop))).toWriteOnly();
                    });
                },
            }),
    );

    /* the probe */

    const points = Array.from({ length: MAX_PROBES }, () => uniform(new THREE.Vector2()));
    const probed = new WgpuBuffer({ renderer, format: 'float32x4', count: MAX_PROBES });
    const probeKernel = new WgpuCompute({
        label: 'oceanProbe',
        body: ({ index }) => {
            If(index.lessThan(uint(MAX_PROBES)), () => {
                let p: TslNode = vec2(0);
                points.forEach((point, n) => {
                    p = index.equal(uint(n)).select(point, p);
                });
                const xz = p.toVar();
                // The surface's moved sideways by the chop: find the water that's moved to here, in two
                // steps back, then its height.
                const found = xz.toVar();
                for (let iteration = 0; iteration < 2; iteration++) {
                    const shift = shapeAt(found, tiles, true);
                    found.assign(xz.sub(vec2(shift.x, shift.z)));
                }
                probed.element(index).assign(vec4(shapeAt(found, tiles, true), 0));
            });
        },
    });

    const batch = new WgpuComputeBatch(renderer);
    // The heights last read back, when they were sampled, and how fast each was changing:
    // they're a frame or two old by the time they arrive, so they're carried on to now.
    let heights: number[] = new Array(MAX_PROBES).fill(0);
    let rates: number[] = new Array(MAX_PROBES).fill(0);
    let sampled = 0;
    let now = 0;
    let reading = false;

    return {
        tiles,
        update(elapsed) {
            time.value = elapsed;
            now = elapsed;
            batch.add(spectrum, ALL);
            for (const s of stages) batch.add(s, ALL / 2);
            for (const u of unpack) batch.add(u, TILE_TEXELS);
            batch.add(probeKernel, MAX_PROBES);
            batch.submit();
            if (!reading) {
                reading = true;
                const asked = elapsed;
                renderer
                    .getArrayBufferAsync(probed.attribute)
                    .then((buffer) => {
                        const values = new Float32Array(buffer);
                        const next = Array.from({ length: MAX_PROBES }, (_, n) => values[n * 4 + 1]);
                        const gap = asked - sampled;
                        if (gap > 1e-3 && gap < 0.5) {
                            rates = next.map((h, n) =>
                                THREE.MathUtils.clamp((h - heights[n]) / gap, -PROBE.fastest, PROBE.fastest),
                            );
                        }
                        heights = next;
                        sampled = asked;
                    })
                    .finally(() => {
                        reading = false;
                    });
            }
        },
        probe(list) {
            list.slice(0, MAX_PROBES).forEach(([x, z], n) => {
                points[n].value.set(x, z);
            });
            const late = Math.min(now - sampled, PROBE.ahead);
            return heights.slice(0, list.length).map((h, n) => h + rates[n] * late);
        },
    };
}

/* reading the waves */

/**
 * The sea's shape at `xz` (where the water was, before the chop moved it): how far
 * it's moved (Dx, height, Dz). `level` reads the textures at full size (for the
 * vertex stage and compute, which have no derivatives to pick a size by).
 */
export function shapeAt(xz: TslNode, tiles: Waves['tiles'], level = false): TslNode {
    let moved: TslNode = vec3(0);
    for (const tile of tiles) {
        const read = texture(tile.shape, xz.div(tile.size));
        moved = moved.add((level ? read.level(0) : read).xyz);
    }
    return moved;
}
