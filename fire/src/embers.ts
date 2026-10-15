/**
 * Embers: the sparks that lift off the fire. Splats rather than THREE.Points so they
 * sort with the scene: as Points, an ember down among the logs would draw in front of
 * them. Walked through the same curl field as the flame, but light and slow to cool,
 * so they ride further on it and coast out over the clearing.
 *
 * A resting fire lets off a few. A stoke throws a SHOWER: each ember reads the heat
 * at its own birth (air.ts), so the ones born in the flare are many, fast and flung
 * outward, and the burst climbs away as one. They're light, so the wind carries them
 * furthest of anything, and each is drawn as a streak along its velocity: a spark
 * crossing the frame in an exposure.
 */

import { type SplatObject, TSL, type TslNode } from 'spark-radix';
import { type Air, heatAt, windAt } from './air';
import { SPARK_ORIGIN } from './scene';
import { flameAlignY, flameCurl, flameHash, particles, seed, time, v3 } from './tsl';

const { Loop, clamp, cos, exp, float, fract, length, mix, normalize, select, sin, smoothstep, sqrt, vec3 } = TSL;

const COUNT = 4000;
const STEPS = 6;

const E = {
    baseRadius: 0.22,
    rate: 0.28,
    riseSpeed: 1.5,
    coolTime: 1.6,
    wind: [0.3, 0, -0.14],
    windResponse: 1.4,
    turbulence: 0.7,
    curlScale: 2.2,
    size: 0.008,
    opacity: 0.85,
    /** The share of embers alight at rest, and how the rest join as the fire flares. */
    restingShare: 0.22,
    flaringShare: 0.7,
    /** A burst: outward speed, m/s, and how quickly it's spent. */
    burstSpeed: 1.0,
    burstTime: 0.35,
    /** Streak length per m/s of speed, in multiples of the ember's size. */
    streak: 0.8,
    hot: [1.0, 0.85, 0.5],
    cool: [0.95, 0.38, 0.1],
} as const;

export function initEmbers(air: Air): { object: SplatObject } {
    const origin = v3(SPARK_ORIGIN);

    const object = particles(COUNT, (index) => {
        const rand = flameHash(seed(index, 5, 101)).toVar();
        const rand2 = flameHash(seed(index, 5, 102)).toVar();
        const rate = rand.x.mul(0.9).add(0.6).mul(E.rate).toVar();
        const age = fract(rand.w.mul(3.71).add(time.mul(rate))).toVar();
        const elapsed = age.div(rate).toVar();

        // How hard the fire was burning when this one left it: 0 resting, 1 flaring.
        const flare = smoothstep(0.45, 0.95, heatAt(air, elapsed)).toVar();
        const alight = rand2.x.lessThan(flare.mul(E.flaringShare - E.restingShare).add(E.restingShare));

        const bedAngle = rand.y.mul(Math.PI * 2).toVar();
        const bedRadius = sqrt(rand.z).mul(E.baseRadius);
        const outward = vec3(cos(bedAngle), 0, sin(bedAngle)).toVar();
        const pos = origin.add(outward.mul(bedRadius)).toVar();
        const kick = rand2.y.mul(0.8).add(0.4).mul(flare).mul(E.burstSpeed).toVar();

        const vel = vec3(0).toVar();
        const dt = elapsed.div(STEPS).toVar();
        Loop(STEPS, ({ i }: { i: TslNode }) => {
            const lifeFraction = float(i).add(0.5).div(STEPS).mul(age).toVar();
            const secondsOld = lifeFraction.div(rate).toVar();
            const stepTime = time.sub(elapsed).add(secondsOld).toVar();

            const buoyancy = flare
                .mul(rand2.z.mul(0.9))
                .add(0.5)
                .mul(exp(secondsOld.negate().div(E.coolTime)))
                .mul(E.riseSpeed);
            const burst = outward.mul(kick.mul(exp(secondsOld.negate().div(E.burstTime))));
            const fieldPos = pos.mul(E.curlScale).sub(vec3(0, stepTime.mul(0.9), 0));
            const curl = flameCurl(fieldPos, stepTime.mul(1.2)).mul(lifeFraction.mul(1.2).add(0.3).mul(E.turbulence));
            const heightAboveFire = clamp(pos.y.sub(origin.y).div(2.5), 0, 1);
            const breeze = v3(E.wind)
                .add(windAt(air, elapsed.sub(secondsOld)).mul(E.windResponse))
                .mul(heightAboveFire.mul(1.6).add(0.15));

            vel.assign(vec3(0, buoyancy, 0).add(burst).add(curl).add(breeze));
            pos.addAssign(vel.mul(dt));
        });

        const wink = sin(time.mul(9).add(rand.w.mul(40)))
            .mul(0.45)
            .add(0.55);
        const fade = smoothstep(0, 0.05, age).mul(smoothstep(0.35, 1, age).oneMinus());
        const scale = rand.x.mul(0.8).add(0.6).mul(age.mul(-0.35).add(1)).mul(E.size).toVar();
        const streak = length(vel).mul(E.streak).add(1);
        // Born in a flare, an ember burns hotter for longer.
        const cooling = smoothstep(0, flare.mul(0.5).add(0.7), age);

        return {
            center: pos,
            scales: vec3(scale, scale.mul(streak), scale),
            quaternion: flameAlignY(normalize(vel.add(vec3(0, 1e-4, 0)))),
            rgb: mix(v3(E.hot), v3(E.cool), cooling),
            opacity: select(alight, wink.mul(fade).mul(flare.mul(0.5).add(0.6)).mul(E.opacity), float(0)),
        };
    });

    return { object };
}
