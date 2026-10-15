/**
 * The coal bed: a glowing crust over the log pile, under the flame. Each coal
 * breathes on its own slow noise, and the bed brightens toward white-orange as the
 * fire is fed and sinks back to red as it settles. Flat-ish splats lying on the bed, so the logs and stones in
 * front of them hide them as the flame's own do.
 */

import { type SplatObject, TSL, type TslNode } from 'spark-radix';
import { type Fire, fireHeat } from './fire';
import { FLAME_ORIGIN } from './scene';
import { flameHash, particles, seed, time, v3 } from './tsl';

const { clamp, cos, mix, pow, select, sin, smoothstep, sqrt, uniform, vec3 } = TSL;

const COUNT = 3000;

const C = {
    radius: 0.55,
    /** The bed's mound: height at the centre and how much each coal sits proud. */
    mound: 0.12,
    jitter: 0.05,
    size: 0.022,
    opacity: 0.75,
    /** Ember-red, orange, yellow-white: what a coal looks like as it heats. */
    dull: [0.4, 0.08, 0.02],
    glow: [1.0, 0.45, 0.1],
    white: [1.0, 0.8, 0.45],
} as const;

export type Coals = { object: SplatObject; heat: TslNode };

export function initCoals(): Coals {
    const heat = uniform(0);
    const origin = v3(FLAME_ORIGIN);

    const object = particles(COUNT, (index) => {
        const rand = flameHash(seed(index, 13, 4001)).toVar();
        const rand2 = flameHash(seed(index, 13, 4002)).toVar();

        const angle = rand.x.mul(Math.PI * 2);
        const r = sqrt(rand.y).toVar();
        const lift = r.mul(r).oneMinus().mul(C.mound).add(rand.z.sub(0.5).mul(C.jitter));
        const pos = origin.add(vec3(cos(angle).mul(r), 0, sin(angle).mul(r)).mul(C.radius)).add(vec3(0, lift.sub(0.06), 0));

        // Slow crawling hot spots.
        const crawl = time.mul(0.6);
        const spots = sin(pos.x.mul(23).add(crawl.mul(1.3)))
            .mul(sin(pos.z.mul(19).sub(crawl)))
            .add(sin(rand2.x.mul(40).add(time.mul(rand2.y.mul(2).add(0.5)))).mul(0.5))
            .mul(0.5)
            .add(0.5);
        const edge = smoothstep(0.55, 1, r).oneMinus();
        const glow = clamp(spots.mul(0.6).add(heat.mul(0.55)).mul(edge).sub(0.2), 0, 1).toVar();

        const rgb = select(
            glow.lessThan(0.5),
            mix(v3(C.dull), v3(C.glow), glow.mul(2)),
            mix(v3(C.glow), v3(C.white), glow.mul(2).sub(1)),
        );
        const size = rand2.z.mul(0.8).add(0.6).mul(C.size);

        return {
            center: pos,
            scales: vec3(size, size.mul(0.35), size),
            rgb,
            opacity: pow(glow, 0.7).mul(C.opacity).mul(edge),
        };
    });

    return { object, heat };
}

export function updateCoals(coals: Coals, fire: Fire): void {
    coals.heat.value = fireHeat(fire);
}
