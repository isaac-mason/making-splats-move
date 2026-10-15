/**
 * The air around the fire: what the fire's heat and the wind have been doing over
 * the last ~20 seconds, as histories every particle can read.
 *
 * Stateless particles can't remember, so they look things up instead. A puff of
 * smoke reads the heat at its own birth, and each step of a particle's path reads
 * the wind blowing at that moment. That's why a stoke rides up the column as a gout
 * rather than the whole column lurching at once, and why a gust bends the flame
 * from the bottom up and then travels away up the smoke.
 *
 * The wind is a slow, wandering gusting on top of the prevailing breeze.
 */

import { TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { type Fire, fireHeat } from './fire';

const { clamp, floor, int, min, mix, uniformArray, vec3 } = TSL;

const SAMPLES = 256;
/** Seconds between samples: SAMPLES * STEP is the longest any particle looks back. */
const STEP = 1 / 12;

/** Gusting, m/s: a light, wandering breeze on top of the prevailing one. */
const GUST_STRENGTH = 0.18;

export type Air = {
    heat: TslNode;
    windX: TslNode;
    windZ: TslNode;
    /** This frame's wind, world xz, m/s. */
    wind: THREE.Vector2;
    sinceSample: number;
};

export function initAir(fire: Fire): Air {
    return {
        heat: uniformArray(new Array(SAMPLES).fill(fireHeat(fire)), 'float'),
        windX: uniformArray(new Array(SAMPLES).fill(0), 'float'),
        windZ: uniformArray(new Array(SAMPLES).fill(0), 'float'),
        wind: new THREE.Vector2(),
        sinceSample: 0,
    };
}

export function updateAir(air: Air, fire: Fire, time: number, dt: number): void {
    const gustX = Math.sin(time * 0.37) + 0.6 * Math.sin(time * 0.93 + 1.3);
    const gustZ = Math.sin(time * 0.29 + 2.0) + 0.6 * Math.sin(time * 0.71 + 0.4);
    air.wind.set(gustX, gustZ).multiplyScalar(GUST_STRENGTH / 1.6);

    const heat: number[] = air.heat.array;
    const windX: number[] = air.windX.array;
    const windZ: number[] = air.windZ.array;
    air.sinceSample += dt;
    while (air.sinceSample >= STEP) {
        air.sinceSample -= STEP;
        heat.copyWithin(1, 0);
        windX.copyWithin(1, 0);
        windZ.copyWithin(1, 0);
    }
    // The newest sample is live.
    heat[0] = fireHeat(fire);
    windX[0] = air.wind.x;
    windZ[0] = air.wind.y;
}

function sample(history: TslNode, secondsAgo: TslNode): TslNode {
    const at = clamp(secondsAgo.div(STEP), 0, SAMPLES - 1).toVar();
    const i = floor(at);
    const next = history.element(int(min(i.add(1), SAMPLES - 1)));
    return mix(history.element(int(i)), next, at.sub(i));
}

/** The fire's heat, 0..1, this many seconds ago. */
export function heatAt(air: Air, secondsAgo: TslNode): TslNode {
    return sample(air.heat, secondsAgo);
}

/** The wind (world, m/s, y = 0) this many seconds ago. */
export function windAt(air: Air, secondsAgo: TslNode): TslNode {
    return vec3(sample(air.windX, secondsAgo), 0, sample(air.windZ, secondsAgo));
}
