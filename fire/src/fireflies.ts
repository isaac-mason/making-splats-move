/**
 * Fireflies: green glints drifting in the dark past the fire. Each is a bright core
 * and a wide faint halo; without the halo they read as pixels at this distance.
 *
 * Nothing is simulated: each hovers about a home in a wedge that widens towards the
 * back, so perspective doesn't squeeze it into a strip. They're dark most of the time
 * and flash on their own slow periods; steadily lit ones would read as fairy lights.
 */

import { type SplatObject, TSL } from 'spark-radix';
import { FIREFLY_BACK_WIDTH, FIREFLY_EXTENT, FIREFLY_NEAR } from './scene';
import { flameHash, particles, seed, time, v3 } from './tsl';

const { fract, max, mix, select, sin, smoothstep, sqrt, uint, vec3 } = TSL;

const COUNT = 180;

const F = {
    wander: [0.6, 0.25],
    periodMin: 4,
    periodMax: 9,
    flashFraction: 0.5,
    idleGlow: 0.04,
    coreSize: 0.02,
    haloSize: 0.12,
    coreOpacity: 0.7,
    haloOpacity: 0.16,
    color: [0.65, 1.0, 0.25],
} as const;

export function initFireflies(): { object: SplatObject } {
    const near = v3(FIREFLY_NEAR);
    const [extentX, extentY, extentZ] = FIREFLY_EXTENT;

    // Even splats are cores, odd ones their halos.
    const object = particles(COUNT * 2, (index) => {
        const fly = index.div(uint(2));
        const isHalo = index.mod(uint(2)).equal(uint(1));
        const rand = flameHash(seed(fly, 7, 313)).toVar();
        const rand2 = flameHash(seed(fly, 11, 719)).toVar();

        const depthEvenlySpread = sqrt(rand.z).toVar();
        const wedgeWidth = mix(extentX, FIREFLY_BACK_WIDTH, depthEvenlySpread);
        const home = near.add(
            vec3(rand.x.sub(0.5).mul(wedgeWidth), rand.y.sub(0.5).mul(extentY), depthEvenlySpread.mul(-extentZ)),
        );

        const phases = rand2.xyz.mul(Math.PI * 2).toVar();
        const hover = vec3(
            sin(time.mul(0.31).add(phases.x)).add(sin(time.mul(0.83).add(phases.y)).mul(0.5)),
            sin(time.mul(0.47).add(phases.z)).add(sin(time.mul(1.21).add(phases.x)).mul(0.4)),
            sin(time.mul(0.27).add(phases.y)).add(sin(time.mul(0.71).add(phases.z)).mul(0.5)),
        ).div(1.5);
        const [wanderXZ, wanderY] = F.wander;
        const pos = home.add(hover.mul(vec3(wanderXZ, wanderY, wanderXZ)));

        const period = mix(F.periodMin, F.periodMax, rand.w);
        const flashPhase = fract(time.div(period).add(rand2.w)).toVar();
        const flashPeak = 0.35 * F.flashFraction;
        const flash = smoothstep(0, flashPeak, flashPhase).mul(smoothstep(flashPeak, F.flashFraction, flashPhase).oneMinus());
        const glow = max(flash, F.idleGlow);

        const size = select(isHalo, F.haloSize, F.coreSize);
        const opacity = select(isHalo, F.haloOpacity, F.coreOpacity);
        const color = v3(F.color);

        return {
            center: pos,
            scales: vec3(size.mul(rand2.x.mul(0.4).add(0.8))),
            rgb: select(isHalo, color, mix(color, vec3(1), 0.35)),
            opacity: opacity.mul(glow),
        };
    });

    return { object };
}
