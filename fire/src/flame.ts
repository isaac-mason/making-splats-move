/**
 * The flame: splats generated on the GPU each frame, nothing stored. Being splats,
 * it sorts with the capture, so the logs and stones in front of it hide it.
 *
 * Stateless, like the dust: every particle is a closed-form function of its index
 * and the time, with `age = fract(seed + time * rate)`. Colour and brightness follow
 * a TEMPERATURE carried along each particle's path, not its age — keyed to age, a
 * lick flung into cold air would glow as bright as one up the core.
 *
 * Two things make it move like a fire rather than a fountain:
 *
 *   puffing — a pool fire breathes at about 1.5 Hz: a gentle necking wave
 *             spirals up the column, pinching gas in and lifting it, so tongues
 *             swell, pinch off and rise away.
 *   wind    — each step of a particle's path is pushed by the wind blowing at that
 *             moment (air.ts), anchored at the bed, so a gust bends it from the top.
 */

import { type SplatObject, TSL, type TslNode } from 'spark-radix';
import { type Air, windAt } from './air';
import { type Fire, fireHeat } from './fire';
import { FLAME_ORIGIN } from './scene';
import { flameAlignY, flameCurl, flameHash, particles, seed, time, v3 } from './tsl';

const {
    Loop,
    cos,
    dot,
    exp,
    float,
    fract,
    length,
    max,
    min,
    mix,
    normalize,
    pow,
    select,
    sin,
    smoothstep,
    sqrt,
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

const COUNT = 62000;
const GLOW_COUNT = 6000;
const STEPS = 6;

const F = {
    baseRadius: 0.5,
    rate: 1.4,
    riseSpeed: 1.65,
    turbulence: 0.95,
    inflow: 0.3,
    burnRate: 15.0,
    burnTime: 0.3,
    mixing: 2.1,
    glowFalloff: 1.6,
    curlScale: 5.0,
    curlScroll: 2.1,
    curlEvolve: 1.2,
    size: 0.015,
    stretch: 3.2,
    unevenness: 0.82,
    opacity: 0.35,
    glowSize: 0.1,
    glowOpacity: 0.022,
    glowSharpness: 4.0,
    /**
     * Breaths per second. Fixed: the phase is time × rate, so a rate that followed
     * the fire's heat would jump the whole flame many cycles at every crackle.
     */
    puffRate: 1.5,
    /** The puff wave's length up the column, metres. */
    puffWavelength: 0.85,
    puffNecking: 0.4,
    puffLift: 0.15,
    windResponse: 0.4,
    hot: [1.0, 0.98, 0.86],
    mid: [1.0, 0.64, 0.24],
    cool: [0.6, 0.2, 0.06],
} as const;

export type Flame = { object: SplatObject; heat: TslNode };

export function initFlame(air: Air): Flame {
    const heat = uniform(0);
    const origin = v3(FLAME_ORIGIN);

    const object = particles(COUNT + GLOW_COUNT, (index) => {
        const rand = flameHash(seed(index)).toVar();
        const rate = rand.x.mul(0.6).add(0.7).mul(F.rate).toVar();
        const age = fract(rand.w.mul(7.13).add(time.mul(rate))).toVar();
        const elapsed = age.div(rate).toVar();

        const bedAngle = rand.y.mul(Math.PI * 2).toVar();
        const bedRadius = sqrt(rand.z).mul(F.baseRadius).toVar();
        const pos = origin.add(vec3(cos(bedAngle), 0, sin(bedAngle)).mul(bedRadius)).toVar();

        const bedNoise = sin(dot(pos.xz, vec2(19, 13)).add(time.mul(0.8)))
            .add(sin(dot(pos.xz, vec2(-11, 27)).add(time.mul(0.55)).add(2.1)).mul(0.7))
            .add(sin(dot(pos.xz, vec2(33, -21)).sub(time.mul(1.1)).add(4.3)).mul(0.5))
            .div(2.2);
        const patchAlight = smoothstep(-0.5, 0.5, bedNoise.add(heat.sub(0.45).mul(1.3)));
        const footprint = sin(bedAngle.mul(3).add(time.mul(0.25)))
            .mul(0.35)
            .add(0.75)
            .add(sin(bedAngle.mul(5).sub(time.mul(0.17)).add(1.3)).mul(0.2));
        const edgeFalloff = min(bedRadius.div(footprint.mul(F.baseRadius)), 1)
            .mul(0.4)
            .oneMinus();
        const fuel = patchAlight.oneMinus().mul(F.unevenness).oneMinus().mul(edgeFalloff).toVar();
        const temp = fuel.mul(0.35).toVar();

        const vel = vec3(0).toVar();
        const dt = elapsed.div(STEPS).toVar();
        Loop(STEPS, ({ i }: { i: TslNode }) => {
            const lifeFraction = float(i).add(0.5).div(STEPS).mul(age).toVar();
            const stepTime = time.sub(elapsed).add(lifeFraction.div(rate)).toVar();
            const fromAxis = pos.xz.sub(origin.xz).toVar();
            const axisDist = length(fromAxis).toVar();

            const fieldPos = pos.mul(F.curlScale).sub(vec3(0, stepTime.mul(F.curlScroll), 0));
            const coolGasWanders = temp.mul(-0.45).add(1.35);
            const curl = flameCurl(fieldPos, stepTime.mul(F.curlEvolve))
                .mul(lifeFraction.mul(0.9).add(0.56).mul(coolGasWanders).mul(F.turbulence))
                .toVar();

            // The puff: a wave travelling up, a turn out of phase around the bed, so
            // tongues spiral up rather than the whole flame pulsing as one.
            const height = pos.y.sub(origin.y);
            const neck = sin(
                stepTime
                    .mul(F.puffRate)
                    .sub(height.div(F.puffWavelength))
                    .mul(Math.PI * 2)
                    .add(bedAngle),
            ).toVar();

            const stillBurning = smoothstep(0, F.burnTime, lifeFraction).oneMinus();
            temp.addAssign(fuel.mul(stillBurning).mul(dt).mul(F.burnRate));
            const edgeExposure = min(axisDist.div(F.baseRadius), 1.6);
            const shear = length(curl).div(F.turbulence);
            const airMixing = edgeExposure
                .mul(1.2)
                .add(0.3)
                .add(shear.mul(0.8))
                .mul(lifeFraction.mul(1.6).add(0.3))
                .mul(F.mixing);
            temp.assign(min(temp.mul(exp(airMixing.mul(dt).negate())), 1));

            const draft = fromAxis
                .negate()
                .div(max(axisDist, 1e-4))
                .mul(
                    lifeFraction
                        .mul(0.7)
                        .oneMinus()
                        .mul(min(axisDist.div(F.baseRadius), 1.5))
                        .mul(F.inflow),
                )
                .mul(neck.mul(F.puffNecking).add(1));
            const buoyancy = temp.mul(F.riseSpeed).mul(neck.mul(F.puffLift).add(1));
            const wind = windAt(air, elapsed.sub(lifeFraction.div(rate))).mul(lifeFraction.mul(1.1).add(0.1).mul(F.windResponse));
            vel.assign(vec3(draft.x, buoyancy, draft.y).add(curl).add(wind));
            pos.addAssign(vel.mul(dt));
        });

        const rgb = select(
            temp.greaterThan(0.5),
            mix(v3(F.mid), v3(F.hot), temp.mul(2).sub(1)),
            mix(v3(F.cool), v3(F.mid), temp.mul(2)),
        );
        const heatBoost = heat.mul(0.6).add(0.55);
        const hotness = max(temp, 0);

        // The last GLOW_COUNT are a few wide, faint splats that haze the flame's body.
        const isGlow = index.greaterThanEqual(uint(COUNT));
        const glowFade = smoothstep(0, 0.1, age).mul(smoothstep(0.55, 1, age).oneMinus());
        const glowScale = rand.x.mul(0.6).add(0.7).mul(F.glowSize);
        const glowOpacity = pow(hotness, F.glowSharpness).mul(heatBoost).mul(glowFade).mul(F.glowOpacity);

        const fade = smoothstep(0, 0.06, age).mul(smoothstep(0.7, 1, age).oneMinus());
        const swell = pow(sin(age.mul(Math.PI)), rand.y.mul(1.1).add(0.55));
        const scale = swell.mul(rand.x.mul(0.7).add(0.6)).mul(heat.mul(0.5).add(0.7)).mul(F.size).toVar();
        const tongueOpacity = pow(hotness, F.glowFalloff).mul(heatBoost).mul(fade).mul(F.opacity);

        return {
            center: pos,
            scales: select(isGlow, vec3(glowScale), vec3(scale, scale.mul(F.stretch), scale)),
            quaternion: select(isGlow, vec4(0, 0, 0, 1), flameAlignY(normalize(vel.add(vec3(0, 1e-4, 0))))),
            rgb,
            opacity: select(isGlow, glowOpacity, tongueOpacity),
        };
    });

    return { object, heat };
}

export function updateFlame(flame: Flame, fire: Fire): void {
    flame.heat.value = fireHeat(fire);
}
