/**
 * The wake, simulated: a patch of water round the boat whose height is stepped
 * on the GPU every frame, so the boat's wake is waves, not a picture of one.
 *
 * The hull pushes the water by moving through it: where its waterline arrives
 * the water's lifted, where it leaves the water's let down, so standing still it
 * does nothing, and passing any spot it leaves no dent behind, only the waves it
 * made. They run out from the bow, spread behind the boat in a V and cross each
 * other as it turns. The water obeys the wave equation, a little damped and
 * smoothed, so the waves fade as they go. Where they run steep,
 * and in the churn right behind the stern, foam is left on the water and slowly
 * dies away where it was left.
 *
 * The grid's addressed by world position and wraps, like the grass's trampling
 * (grass/): each cell remembers which bit of sea it holds and starts flat when it
 * wraps round to new water ahead of the boat. The sea (sea.ts) reads it for its
 * height, its slope and its foam, fading it out towards the grid's edge.
 *
 * WebGPU only: with no compute (the WebGL2 backend) there's no wake.
 *
 * Sections: settings · the grid · the step · reading it.
 */

import { TSL, type TslNode, WgpuBuffer, WgpuCompute, WgpuComputeBatch } from '@sparkjsdev/radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

const { Fn, If, abs, cos, float, floor, max, mix, sin, smoothstep, uint, uniform, vec2, vec4 } = TSL;

/* settings */

/**
 * The grid: this many cells across, each this big (metres): 72 m of water round
 * the boat. How fast its waves run (m/s; the V behind the boat narrows as it goes
 * faster than this); how fast they die (per second) and how much they're smoothed
 * each step, so the grid's own ripples don't build up; and how much it's faded
 * out towards its edge (metres).
 */
const GRID = { cells: 512, cell: 0.14, speed: 2.4, damping: 0.35, smooth: 0.04, fade: 8 };

/**
 * The hull pushing the water: its waterline's half-width and half-length
 * (metres), how soft its edge is (a share), and how far it lifts the water ahead
 * of it, and lets it down behind, as its waterline passes (metres); and how much
 * bigger than its waterline the wake's height is kept out from under it.
 */
const HULL = { wide: 0.6, long: 1.55, soft: 0.35, push: 0.03, clear: 1.25 };

/**
 * Foam: left where the waves run steeper than this (to this), this fast (per
 * second); churned up just behind the stern when the boat's moving faster than
 * this (m/s), over this much of its length; and how long it lasts (seconds).
 */
const FOAM = { steep: [0.14, 0.3], rate: 1.2, churn: 1.1, churnFrom: 1, churnLength: 1.4, life: 3.5 };

/* the grid */

const N = GRID.cells;

/** The boat, now and at the last step: (x, z, heading). */
const boatNow = uniform(new THREE.Vector3());
const boatBefore = uniform(new THREE.Vector3());
/** The step, in seconds. */
const dt = uniform(1 / 60);

/** `x` modulo `n`, always 0..n: WGSL's own keeps a negative's sign, and world cells go negative. */
const wrap = (x: TslNode, n: number): TslNode => x.sub(x.div(n).floor().mul(n));

/** The world cell that grid slot `slot` holds now: of all that share it, the nearest the boat. */
function slotCell(slot: TslNode): TslNode {
    const boats = boatNow.xy.div(GRID.cell).floor();
    return boats.add(wrap(slot.sub(boats).add(N / 2), N).sub(N / 2));
}

/** Where world cell `cell` is kept: its slot's index. */
const indexOf = (cell: TslNode): TslNode => {
    const slot = wrap(cell, N);
    return uint(slot.y.mul(N).add(slot.x));
};

/** How much of the hull's waterline is over `xz`, with the boat at `boat` (0..1), its outline grown `by` this much. */
function hullOver(xz: TslNode, boat: TslNode, by = 1): TslNode {
    const forward = vec2(sin(boat.z), cos(boat.z).negate());
    const d = xz.sub(boat.xy);
    const local = vec2(
        d.x
            .mul(forward.y)
            .sub(d.y.mul(forward.x))
            .div(HULL.wide * by),
        d.x
            .mul(forward.x)
            .add(d.y.mul(forward.y))
            .div(HULL.long * by),
    );
    return smoothstep(1, 1 - HULL.soft, local.length());
}

/** How far behind the stern `xz` is in the churn, with the boat at `boat` (0..1). */
function inChurn(xz: TslNode, boat: TslNode): TslNode {
    const forward = vec2(sin(boat.z), cos(boat.z).negate());
    const d = xz.sub(boat.xy);
    const behind = d.x.mul(forward.x).add(d.y.mul(forward.y)).negate().sub(HULL.long);
    const side = abs(d.x.mul(forward.y).sub(d.y.mul(forward.x)));
    return smoothstep(-0.2, 0.2, behind)
        .mul(smoothstep(FOAM.churnLength, 0, behind))
        .mul(smoothstep(HULL.wide, HULL.wide * 0.3, side));
}

/* the step */

export type Wake = {
    /** The sea at `xz`, from the wake: (height, slope x, slope z, foam), faded out towards the grid's edge. */
    at: (xz: TslNode) => TslNode;
    /** Where the wake's height moves the water at `xz` (for the mesh: a smooth, cheaper read). */
    heightAt: (xz: TslNode) => TslNode;
    /** Step it: the boat's here now, heading this way; `seconds` since the last step. */
    step: (seconds: number, x: number, z: number, heading: number) => void;
};

/** No compute, no wake: the sea reads nothing. */
const still: Wake = { at: () => vec4(0), heightAt: () => float(0), step: () => {} };

export function initWake(renderer: WebGPURenderer, compute: boolean): Wake {
    if (!compute) return still;
    // (height, height a step ago, foam, unused), two of them, stepped from one to the other;
    // and which world cell each slot holds.
    const states = [0, 1].map(() => new WgpuBuffer({ renderer, format: 'float32x4', count: N * N }));
    const owner = new WgpuBuffer({ renderer, format: 'float32x2', count: N * N });

    /** World cell `cell`'s state in `from`, or flat water if its slot holds somewhere else. */
    const stateOf = (from: WgpuBuffer<'float32x4'>, cell: TslNode): TslNode => {
        const index = indexOf(cell);
        return owner.element(index).equal(cell).all().select(from.element(index), vec4(0));
    };

    const kernels = [0, 1].map((k) => {
        const from = states[k];
        const to = states[1 - k];
        return new WgpuCompute({
            label: `wake${k}`,
            body: ({ index }) => {
                If(index.lessThan(uint(N * N)), () => {
                    const cell = slotCell(vec2(float(index.mod(uint(N))), float(index.div(uint(N))))).toVar();
                    const here = stateOf(from, cell).toVar();
                    const east = stateOf(from, cell.add(vec2(1, 0))).x;
                    const west = stateOf(from, cell.sub(vec2(1, 0))).x;
                    const north = stateOf(from, cell.add(vec2(0, 1))).x;
                    const south = stateOf(from, cell.sub(vec2(0, 1))).x;
                    const around = east.add(west).add(north).add(south).toVar();

                    // The wave equation, damped: on as it was going, pulled by its neighbours; and
                    // pushed by the hull, lifted where its waterline arrives and let down where it leaves.
                    const xz = cell.add(0.5).mul(GRID.cell);
                    const going = here.x.sub(here.y).mul(dt.mul(-GRID.damping).exp());
                    const pull = around.sub(here.x.mul(4)).mul((GRID.speed / GRID.cell) ** 2);
                    const pushed = hullOver(xz, boatNow).sub(hullOver(xz, boatBefore)).mul(HULL.push);
                    const next = here.x
                        .add(going)
                        .add(pull.mul(dt.mul(dt)))
                        .add(pushed)
                        .toVar();
                    // Smoothed a little towards its neighbours, so the grid's own ripples don't build.
                    next.assign(mix(next, around.mul(0.25), GRID.smooth));

                    // Foam: left where the waves are steep, and churned up behind the stern.
                    const slope = vec2(east.sub(west), north.sub(south))
                        .div(2 * GRID.cell)
                        .length();
                    const speed = boatNow.xy.sub(boatBefore.xy).length().div(dt.max(1e-4));
                    const churned = inChurn(xz, boatNow)
                        .mul(smoothstep(FOAM.churnFrom, FOAM.churnFrom + 2, speed))
                        .mul(FOAM.churn);
                    const made = smoothstep(FOAM.steep[0], FOAM.steep[1], slope).mul(FOAM.rate).add(churned);
                    const foam = here.z.mul(dt.div(-FOAM.life).exp()).add(made.mul(dt)).clamp(0, 1);

                    to.element(index).assign(vec4(next, here.x, foam, 0));
                    owner.element(index).assign(cell);
                });
            },
        });
    });

    const batch = new WgpuComputeBatch(renderer);
    let current = 0;
    let started = false;
    // The sea reads whichever state was written last: both are read, picked by a uniform.
    const reading = uniform(0);
    const read = (cell: TslNode): TslNode => {
        const index = indexOf(cell);
        const value = reading.equal(0).select(states[0].element(index), states[1].element(index));
        return owner.element(index).equal(cell).all().select(value, vec4(0));
    };

    /** Faded out towards the grid's edge, so the wake doesn't end in a line. */
    const fadeAt = (xz: TslNode): TslNode => {
        const away = abs(xz.sub(boatNow.xy));
        const edge = (N / 2 - 2) * GRID.cell;
        return smoothstep(edge, edge - GRID.fade, max(away.x, away.y));
    };

    /** How much of the wake's height shows at `xz`: none under the hull (a little past its waterline). */
    const underHull = (xz: TslNode): TslNode => hullOver(xz, boatNow, HULL.clear).oneMinus();

    /** (height, slope x, slope z, foam) at the middle of `cell`. */
    const cellAt = (cell: TslNode): TslNode => {
        const here = read(cell);
        const slope = vec2(
            read(cell.add(vec2(1, 0))).x.sub(read(cell.sub(vec2(1, 0))).x),
            read(cell.add(vec2(0, 1))).x.sub(read(cell.sub(vec2(0, 1))).x),
        ).div(2 * GRID.cell);
        return vec4(here.x, slope, here.z);
    };

    const at = Fn(([xz]: [TslNode]) => {
        const out = vec4(0).toVar();
        // Only near enough the boat to be on the grid.
        If(fadeAt(xz).greaterThan(0), () => {
            const p = xz.div(GRID.cell).sub(0.5).toVar();
            const cell = floor(p).toVar();
            const f = p.sub(cell).toVar();
            const a = cellAt(cell);
            const b = cellAt(cell.add(vec2(1, 0)));
            const c = cellAt(cell.add(vec2(0, 1)));
            const d = cellAt(cell.add(vec2(1, 1)));
            const wake = mix(mix(a, b, f.x), mix(c, d, f.x), f.y).mul(fadeAt(xz));
            // Not raised inside the hull: the hull's there, and the water belongs round it.
            out.assign(wake.mul(vec4(underHull(xz), 1, 1, 1)));
        });
        return out;
    });

    const heightAt = Fn(([xz]: [TslNode]) => {
        const out = float(0).toVar();
        If(fadeAt(xz).greaterThan(0), () => {
            const p = xz.div(GRID.cell).sub(0.5).toVar();
            const cell = floor(p).toVar();
            const f = p.sub(cell).toVar();
            const h = (o: [number, number]) => read(cell.add(vec2(o[0], o[1]))).x;
            out.assign(
                mix(mix(h([0, 0]), h([1, 0]), f.x), mix(h([0, 1]), h([1, 1]), f.x), f.y)
                    .mul(fadeAt(xz))
                    .mul(underHull(xz)),
            );
        });
        return out;
    });

    return {
        at: (xz) => at(xz),
        heightAt: (xz) => heightAt(xz),
        step(seconds, x, z, heading) {
            boatBefore.value.copy(started ? boatNow.value : new THREE.Vector3(x, z, heading));
            boatNow.value.set(x, z, heading);
            started = true;
            // A steady step: the waves are only stable while one doesn't carry them past a cell.
            dt.value = Math.min(Math.max(seconds, 1e-3), 1 / 40);
            batch.add(kernels[current], N * N);
            batch.submit();
            current = 1 - current;
            reading.value = current;
        },
    };
}
