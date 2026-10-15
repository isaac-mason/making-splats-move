/**
 * Smoke: the layer above the flame, and what sells "burning" over "glowing". Each
 * puff lives ten seconds or more, rising, spreading and thinning to nothing.
 *
 * Heat is DELAYED: each puff reads the fire's heat as it was at its own birth, from
 * the air's history (air.ts), so a stoke travels up the column as a gout instead of the whole
 * column lurching at once.
 *
 * Two things give it shape:
 *
 *   break-up — it rises clean and narrow at first, then past a wavering height the
 *              turbulence takes over and it shreds and spreads, as real smoke does.
 *   density  — puffs from the middle of the bed make the column's dense core: they
 *              are darker and shade the firelight for the smoke above them, while
 *              thin edge puffs stay pale and catch the light.
 *
 * Colour is written straight, not premultiplied: the draw premultiplies, and doing
 * it here too leaves the puffs a near-black filter.
 */

import { type SplatObject, TSL, type TslNode } from 'spark-radix';
import { type Air, heatAt, windAt } from './air';
import { type Fire, fireHeat } from './fire';
import { FLAME_ORIGIN } from './scene';
import { flameCurl, flameHash, particles, seed, time, v3 } from './tsl';

const { Loop, clamp, cos, exp, float, fract, length, max, mix, pow, sin, smoothstep, sqrt, uniform, vec3 } = TSL;

const COUNT = 4500;
const STEPS = 24;

const S = {
    baseRadius: 0.16,
    liftOff: 0.55,
    rate: 0.085,
    riseSpeed: 1.3,
    coolTime: 5.0,
    terminalRise: 0.1,
    spread: 0.13,
    turbulence: 0.25,
    /** Metres above the fire where the column breaks up, and how far that wavers. */
    breakHeight: 1.3,
    breakWaver: 0.3,
    /** Turbulence below the break and after it, as multiples of `turbulence`. */
    laminar: 0.12,
    shredded: 2.2,
    /** How hard the dense core shades the light from below. */
    selfShadow: 2.5,
    curlScale: 0.7,
    curlScroll: 0.12,
    wind: [0.22, 0, -0.1],
    gust: 0.55,
    startSize: 0.05,
    endSize: 0.5,
    opacity: 0.028,
    /** Thin, pale edges and the dark, dense core; drifting cooler and bluer with age. */
    edge: [0.2, 0.19, 0.21],
    core: [0.07, 0.07, 0.08],
    cool: [0.1, 0.11, 0.15],
    /** The flame's light on the smoke's underside, and how quickly it fades with height. */
    firelit: [1.0, 0.6, 0.3],
    firelitHeight: 0.6,
} as const;

export type Smoke = { object: SplatObject; heat: TslNode };

export function initSmoke(air: Air): Smoke {
    const origin = v3(FLAME_ORIGIN);
    const heat = uniform(0);

    const object = particles(COUNT, (index) => {
        const rand = flameHash(seed(index, 3, 7)).toVar();
        const rand2 = flameHash(seed(index, 3, 8)).toVar();
        const rate = rand.x.mul(0.6).add(0.7).mul(S.rate).toVar();
        const age = fract(rand.w.mul(5.37).add(time.mul(rate))).toVar();
        const elapsed = age.div(rate).toVar();
        const heatAtBirth = heatAt(air, elapsed).toVar();

        const bedAngle = rand.y.mul(Math.PI * 2);
        const bedRadius = sqrt(rand.z).mul(S.baseRadius);
        const handoverHeight = rand2.x.mul(0.8).add(0.6).mul(S.liftOff);
        const pos = origin.add(vec3(cos(bedAngle).mul(bedRadius), handoverHeight, sin(bedAngle).mul(bedRadius))).toVar();

        // Where the column breaks: one height for everyone, wavering slowly.
        const breakHeight = sin(time.mul(0.23)).mul(S.breakWaver).add(S.breakHeight).toVar();
        const shredAt = (height: TslNode) => smoothstep(breakHeight.mul(0.75), breakHeight.mul(1.5), height);

        const dt = elapsed.div(STEPS).toVar();
        Loop(STEPS, ({ i }: { i: TslNode }) => {
            const secondsOld = float(i).add(0.5).mul(dt);
            const heightAboveFire = clamp(pos.y.sub(origin.y).div(5), 0, 1).toVar();
            const shred = shredAt(pos.y.sub(origin.y)).toVar();

            const rise = heatAtBirth
                .mul(0.9)
                .add(0.5)
                .mul(exp(secondsOld.negate().div(S.coolTime)))
                .mul(S.riseSpeed)
                .add(S.terminalRise)
                .toVar();

            const fromAxis = pos.xz.sub(origin.xz);
            const outward = fromAxis.div(max(length(fromAxis), 1e-4));
            const spread = outward.mul(rise.add(0.4).mul(shred.mul(1.5).add(0.5)).mul(S.spread));

            const fieldPos = pos.mul(S.curlScale).sub(vec3(0, time.mul(S.curlScroll), 0));
            const curl = flameCurl(fieldPos, time.mul(0.12)).mul(mix(S.laminar, S.shredded, shred).mul(S.turbulence));

            const gustTravellingUp = sin(time.mul(0.21).add(pos.y.mul(0.45)))
                .mul(0.6)
                .add(sin(time.mul(0.37).add(1.7)).mul(0.4))
                .mul(S.gust)
                .add(1);
            const breeze = v3(S.wind)
                .mul(gustTravellingUp)
                .add(windAt(air, elapsed.sub(secondsOld)))
                .mul(heightAboveFire.mul(1.2).add(0.1));

            pos.addAssign(vec3(spread.x, rise, spread.y).add(curl).add(breeze).mul(dt));
        });

        const fade = smoothstep(0, 0.1, age).mul(pow(max(age.oneMinus(), 0), 2.2));

        // Density: core puffs are thick, thinning as the column spreads and shreds.
        const height = pos.y.sub(origin.y).toVar();
        const thick = sqrt(rand.z).oneMinus().mul(age.mul(-0.6).add(1)).mul(shredAt(height).mul(-0.5).add(1)).toVar();
        // The light from below, after the dense smoke it has come up through.
        const transmitted = exp(thick.mul(smoothstep(0, 1.2, height)).mul(-S.selfShadow)).toVar();
        const firelit = v3(S.firelit)
            .mul(exp(max(height.sub(0.3), 0).div(-S.firelitHeight)))
            .mul(heat.mul(0.8).add(0.35))
            .mul(transmitted);
        const base = mix(mix(v3(S.edge), v3(S.core), thick), v3(S.cool), smoothstep(0.2, 0.8, age).mul(0.5));

        return {
            center: pos,
            scales: vec3(mix(float(S.startSize), float(S.endSize), pow(age, 0.7))),
            // Lit from below by the flame as it is now: the column glows over the fire.
            rgb: base.mul(transmitted.mul(0.4).add(0.6)).add(firelit),
            opacity: fade.mul(heatAtBirth.mul(1.1).add(0.25)).mul(thick.mul(1.2).add(0.6)).mul(S.opacity),
        };
    });

    return { object, heat };
}

export function updateSmoke(smoke: Smoke, fire: Fire): void {
    smoke.heat.value = fireHeat(fire);
}
