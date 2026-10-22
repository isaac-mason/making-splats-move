/**
 * The snow: flakes in the globe's fluid, simulated on the GPU, settling on the
 * city and whirled up again when you shake it.
 *
 * Everything is in the globe's own frame, centred on the glass: when you shake
 * it the whole globe moves, and the fluid inside, lagging, pushes the flakes the
 * other way, as in a real one. A flake is carried by the fluid and sinks
 * through it slowly, eased towards that every step (a flake is all drag). The
 * fluid is still until shaken: a shake gives it energy, which drives a swirl
 * (curl noise, so it stirs without bunching) and a slow spin of the whole fluid
 * about the glass's axis, and dies away over a few seconds.
 *
 * A flake reaching the city stops there: the city's top surfaces are a
 * heightfield baked from the capture (scripts/bake-heights.mjs), past the cut
 * it's the diorama's base, and the glass holds the rest in. A flake landing while
 * the fluid is calm settles and stays, so the roofs and the street whiten; a
 * hard enough shake lifts settled flakes back into the flow.
 *
 * Without compute (the WebGL2 backend) there's no simulation: snow just falls,
 * forever, each flake worked out from its index and the time.
 *
 * Sections: settings · the heightfield · the fluid · kernels · splats.
 */

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
import heightsUrl from '../assets/heights.bin?url';
import { DIORAMA, GLASS, glassCentre } from './globe';

const {
    If,
    abs,
    cos,
    cross,
    exp,
    float,
    floor,
    fract,
    hash,
    int,
    length,
    max,
    mix,
    mx_noise_vec3,
    sin,
    sqrt,
    uint,
    uniform,
    vec3,
    vec4,
} = TSL;

/* settings */

/** How many flakes, and how big (a standard deviation, metres), give or take. */
const FLAKES = { count: 48_000, size: 0.045, vary: 0.6 };

/**
 * How flakes move through the fluid: how fast they sink (m/s, give or take), how
 * fast they ease to the fluid's flow (per second), and how hard the globe's
 * motion pushes them (for its acceleration).
 */
const SINK = { speed: [0.55, 1.2], ease: 2.5, push: 0.6 };

/**
 * The fluid once shaken: how fast its swirl runs at full energy (m/s) and how
 * big its eddies are, how fast it spins about the glass's axis, how fast the
 * energy dies away (seconds), and how much a shake gives it, for the globe's
 * acceleration (m/s²).
 */
const FLUID = { swirl: 6, eddies: 7, spin: 0.25, calm: 6, stir: 0.012 };

/**
 * Settling: a flake landing slower than this (m/s), while the energy is under
 * this, stays; settled flakes are lifted again once the energy passes this.
 * How far a settled flake sits up off the surface, at most.
 */
const SETTLE = { slower: 1.2, calm: 0.25, lift: 0.45, heap: 0.06 };

/** Simulation steps: never longer than this. */
const STEP = 1 / 30;

/** The snow's colour: white, a little cool, each flake its own brightness. */
const WHITE = [0.95, 0.96, 1];

/* the heightfield */

const { size: CELLS, cell: CELL } = DIORAMA.heights;
/** Where the heightfield's first cell starts, in the globe's frame. */
const gridOrigin = new THREE.Vector2(
    DIORAMA.centre[0] - (CELLS * CELL) / 2 - glassCentre.x,
    DIORAMA.centre[1] - (CELLS * CELL) / 2 - glassCentre.z,
);
/** The base's height in the globe's frame. */
const BASE = DIORAMA.base - glassCentre.y;

/** The surface's height under `xz` (globe frame): the city's heightfield inside the cut, the base past it. Bilinear. */
function surfaceAt(heights: WgpuBuffer<'float32'>, xz: TslNode): TslNode {
    const g = xz
        .sub(vec3(gridOrigin.x, 0, gridOrigin.y).xz)
        .div(CELL)
        .sub(0.5)
        .toVar();
    const c = floor(g).toVar();
    const f = fract(g).toVar();
    const at = (dx: number, dz: number) => {
        const x = int(c.x)
            .add(dx)
            .clamp(0, CELLS - 1);
        const z = int(c.y)
            .add(dz)
            .clamp(0, CELLS - 1);
        return heights.element(z.mul(CELLS).add(x)).sub(glassCentre.y);
    };
    const h = mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
    // The glass is centred over the cut, so the cut is a disc round the frame's axis.
    const inCut = length(xz).lessThan(DIORAMA.radius);
    return inCut.select(h, float(BASE));
}

/* the fluid */

/** The simulation's uniforms (the splats have their own). */
const sim = {
    dt: uniform(STEP),
    time: uniform(0),
    /** 0..1: how stirred up the fluid is. */
    energy: uniform(0),
    /** The globe's acceleration (xyz), m/s². */
    shaken: uniform(new THREE.Vector4()),
};

/** The fluid's flow at `p` (globe frame): a swirl (the curl of a vector noise, drifting) and a spin about the glass's axis, both by the energy. */
function flowAt(p: TslNode): TslNode {
    const q = p
        .div(FLUID.eddies)
        .add(vec3(sim.time.mul(0.15), sim.time.mul(0.11), sim.time.mul(-0.13)))
        .toVar();
    const e = 0.05;
    const dx = mx_noise_vec3(q.add(vec3(e, 0, 0)))
        .sub(mx_noise_vec3(q.sub(vec3(e, 0, 0))))
        .toVar();
    const dy = mx_noise_vec3(q.add(vec3(0, e, 0)))
        .sub(mx_noise_vec3(q.sub(vec3(0, e, 0))))
        .toVar();
    const dz = mx_noise_vec3(q.add(vec3(0, 0, e)))
        .sub(mx_noise_vec3(q.sub(vec3(0, 0, e))))
        .toVar();
    const curl = vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x)).div(2 * e);
    const spin = cross(vec3(0, FLUID.spin, 0), p);
    return curl.mul(FLUID.swirl).add(spin).mul(sim.energy);
}

/* kernels */

type Snow = {
    /** xyz in the globe's frame, w: 1 once settled. */
    pos: WgpuBuffer<'float32x4'>;
    /** xyz velocity, w: how fast this flake sinks. */
    vel: WgpuBuffer<'float32x4'>;
    heights: WgpuBuffer<'float32'>;
    init: WgpuCompute;
    fall: WgpuCompute;
    batch: WgpuComputeBatch;
};

const perFlake = (label: string, body: (index: TslNode) => void) =>
    new WgpuCompute({
        label,
        body: ({ index }) => {
            If(index.lessThan(uint(FLAKES.count)), () => body(index));
        },
    });

function makeSnow(renderer: WebGPURenderer): Snow {
    const pos = new WgpuBuffer({ renderer, format: 'float32x4', count: FLAKES.count });
    const vel = new WgpuBuffer({ renderer, format: 'float32x4', count: FLAKES.count });
    const heights = new WgpuBuffer({ renderer, format: 'float32', count: CELLS * CELLS });

    // Anywhere in the glass above the city, as if just shaken.
    const init = perFlake('snowInit', (index) => {
        const h = (k: number) => hash(index.mul(uint(11)).add(uint(k)));
        const z = h(0).mul(2).sub(1);
        const a = h(1).mul(Math.PI * 2);
        const r = h(2)
            .pow(1 / 3)
            .mul(GLASS.radius * 0.9);
        const p = vec3(sqrt(z.mul(z).oneMinus()).mul(cos(a)), z, sqrt(z.mul(z).oneMinus()).mul(sin(a)))
            .mul(r)
            .toVar();
        p.y.assign(max(p.y, surfaceAt(heights, p.xz).add(0.5)));
        pos.element(index).assign(vec4(p, 0));
        vel.element(index).assign(vec4(0, 0, 0, mix(SINK.speed[0], SINK.speed[1], h(3))));
    });

    const fall = perFlake('snowFall', (index) => {
        const h = (k: number) => hash(index.mul(uint(11)).add(uint(k)));
        const state = pos.element(index).toVar();
        const motion = vel.element(index).toVar();
        const p = state.xyz.toVar();
        const v = motion.xyz.toVar();
        const settled = state.w.toVar();

        // Settled flakes stay put, until a hard enough shake lifts them (some sooner than others).
        If(settled.greaterThan(0.5).and(sim.energy.greaterThan(mix(SETTLE.lift, 1, h(4)))), () => {
            settled.assign(0);
            v.assign(vec3(0, 0.5, 0));
        });

        If(settled.lessThan(0.5), () => {
            // Carried by the fluid and sinking through it; pushed the other way by the globe's acceleration.
            const wants = flowAt(p).sub(vec3(0, motion.w, 0));
            v.assign(mix(wants, v, exp(sim.dt.mul(-SINK.ease))));
            v.subAssign(sim.shaken.xyz.mul(SINK.push).mul(sim.dt));
            p.addAssign(v.mul(sim.dt));

            // Held in by the glass.
            const out = length(p);
            const inside = GLASS.radius - 0.3;
            If(out.greaterThan(inside), () => {
                const n = p.div(out);
                p.assign(n.mul(inside));
                v.subAssign(n.mul(max(v.dot(n), 0)));
            });

            // Stopped by the city: settling there if the fluid's calm and it's landing gently.
            const ground = surfaceAt(heights, p.xz).toVar();
            If(p.y.lessThan(ground), () => {
                p.y.assign(ground);
                If(sim.energy.lessThan(SETTLE.calm).and(length(v).lessThan(SETTLE.slower)), () => {
                    settled.assign(1);
                    p.y.addAssign(h(5).mul(SETTLE.heap));
                    v.assign(vec3(0));
                }).Else(() => {
                    v.y.assign(abs(v.y).mul(0.2));
                });
            });
        });

        pos.element(index).assign(vec4(p, settled));
        vel.element(index).assign(vec4(v, motion.w));
    });

    return { pos, vel, heights, init, fall, batch: new WgpuComputeBatch(renderer) };
}

/* splats */

/** The splats' own uniforms: where the globe is (its shake), and the time for the stateless snow. */
const look = { offset: uniform(new THREE.Vector4()), time: uniform(0) };

/** A flake without a simulation: falling through the glass forever, from its index and the time. */
function statelessFlake(index: TslNode): { p: TslNode; settled: TslNode } {
    const h = (k: number) => hash(index.mul(uint(11)).add(uint(k)));
    const speed = mix(SINK.speed[0], SINK.speed[1], h(3));
    const fallFrom = GLASS.radius * 0.9;
    const span = fallFrom - BASE;
    const fallen = fract(look.time.mul(speed).div(span).add(h(0))).mul(span);
    const a = h(1).mul(Math.PI * 2);
    const r = sqrt(h(2)).mul(DIORAMA.radius);
    const sway = sin(look.time.mul(0.7).add(h(4).mul(20))).mul(0.4);
    return { p: vec3(cos(a).mul(r).add(sway), float(fallFrom).sub(fallen), sin(a).mul(r)), settled: float(0) };
}

function snowSplats(snow: Snow | null): SplatObject {
    const generateSplat = (index: TslNode) => {
        const h = (k: number) => hash(index.mul(uint(7)).add(uint(k)));
        let p: TslNode;
        let settled: TslNode;
        if (snow) {
            const state = snow.pos.element(index).toVar();
            p = state.xyz;
            settled = state.w;
        } else {
            ({ p, settled } = statelessFlake(index));
        }
        const centre = p.add(vec3(glassCentre.x, glassCentre.y, glassCentre.z)).add(look.offset.xyz);
        // A soft round flake; lying flatter once it's settled, so the snow builds a cover.
        const size = exp(h(0).sub(0.5).mul(FLAKES.vary)).mul(FLAKES.size);
        const scales = vec3(size, mix(size, size.mul(0.35), settled), size);
        const rgb = vec3(WHITE[0], WHITE[1], WHITE[2]).mul(h(1).mul(0.15).add(0.85));
        return GpuSplats.Splat(centre, scales, vec4(0, 0, 0, 1), rgb, float(0.9), uint(index));
    };
    return SplatCollection.object({ count: FLAKES.count, generator: { generateSplat } });
}

/* the snow, from the outside */

export type SnowFall = {
    object: SplatObject;
    /** Step the snow on; `offset` is where the shaken globe is now, `accel` its acceleration. */
    update: (elapsed: number, dt: number, offset: THREE.Vector3, accel: THREE.Vector3) => void;
};

export async function initSnow(renderer: WebGPURenderer, compute: boolean): Promise<SnowFall> {
    const snow = compute ? makeSnow(renderer) : null;
    let energy = 0.6;
    if (snow) {
        const bytes = await (await fetch(heightsUrl)).arrayBuffer();
        snow.heights.upload(new Float32Array(bytes));
        snow.batch.add(snow.init, FLAKES.count).submit();
    }
    return {
        object: snowSplats(snow),
        update(elapsed, dt, offset, accel) {
            (look.offset.value as THREE.Vector4).set(offset.x, offset.y, offset.z, 0);
            look.time.value = elapsed;
            if (!snow) return;
            // A shake stirs the fluid; it calms over a few seconds.
            energy = Math.min(1, energy * Math.exp(-dt / FLUID.calm) + accel.length() * FLUID.stir * dt * 60);
            const step = Math.min(dt, STEP);
            sim.dt.value = step;
            sim.time.value = elapsed;
            sim.energy.value = energy;
            (sim.shaken.value as THREE.Vector4).set(accel.x, accel.y, accel.z, 0);
            snow.batch.add(snow.fall, FLAKES.count).submit();
        },
    };
}
