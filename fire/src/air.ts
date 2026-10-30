import { TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';
import { type Fire, fireHeat } from './fire';

const { clamp, floor, int, min, mix, uniformArray, vec3 } = TSL;

const SAMPLES = 256;
const STEP = 1 / 12;

const GUST_STRENGTH = 0.18;

export type Air = {
    heat: TslNode;
    windX: TslNode;
    windZ: TslNode;
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

export function heatAt(air: Air, secondsAgo: TslNode): TslNode {
    return sample(air.heat, secondsAgo);
}

export function windAt(air: Air, secondsAgo: TslNode): TslNode {
    return vec3(sample(air.windX, secondsAgo), 0, sample(air.windZ, secondsAgo));
}
