import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { CURL_GLSL } from './curl';
import type { Furnace } from './furnace';
import { furnaceHeat } from './furnace';
import { FLAME_ORIGIN } from './scene';

/**
 * The flame body — Gaussian splats generated on the GPU, nothing stored.
 *
 * The scene's own fire is baked into the photograph, so it can only ever brighten.
 * This puts actual burning geometry in front of it: splats that rise, wander,
 * swell, burn, cool and die, continuously — colour and brightness read off a
 * temperature they carry with them rather than off their age.
 *
 * Being splats rather than a THREE.Points cloud is what makes it sit IN the
 * firebox rather than on top of the picture of one — they sort and blend with the
 * boiler's own splats, so the grate and the iron shell occlude the flame exactly
 * as they should.
 *
 * The statelessness works the same way as src/dust.ts — hash the splat index for a
 * stable seed, then evaluate a closed-form function of (seed, time) — with one
 * addition. A flame particle has a LIFETIME, and that would normally mean tracking
 * birth and death per particle. Instead its age is itself a fract():
 *
 *     age = fract(seed + time * rate)
 *
 * so every particle sweeps 0..1 forever, wrapping instantly back to newborn. The
 * seed offsets each one, so at any instant the population is evenly spread across
 * all ages. Same recycling trick as the dust field, applied to time instead of
 * space, and it's what removes the last reason to keep a particle buffer.
 */

export type FlameParams = {
    /** Number of splats in the flame. They're recycled continuously, so this is the population. */
    count: number;
    /** Radius of the fuel bed particles are picked up from, in world units. */
    baseRadius: number;
    /** Lifetimes per second. Fire is fast — a lick of flame exists for well under a second. */
    rate: number;
    /**
     * Buoyancy per unit of temperature, in world units per second. Sets how tall
     * the fire gets.
     *
     * Scaled by the particle's own temperature rather than by a hand-drawn ramp
     * over its life, because that IS what buoyancy is: hot gas rises because it's
     * less dense than the air around it, so a tongue that mixes early and goes
     * cold stops climbing on its own. Rise and colour then can't disagree.
     */
    riseSpeed: number;
    /** Strength of the curl field, in world units per second. The only source of structure. */
    turbulence: number;
    /**
     * Inward draft, in world units per second.
     *
     * A fire pulls air in at its base to feed itself, which is why flame necks
     * INWARD as it climbs rather than spreading. Without it, buoyancy plus
     * turbulence is just a fountain: everything sprays outward and upward and it
     * reads as a jet, not a fire.
     */
    inflow: number;
    /**
     * TEMPERATURE. 1.0 is as hot as the flame gets (near-white); 0 is ambient air.
     *
     * Everything you see about a flame — its colour, its brightness, how hard it
     * climbs — is a reading of temperature, and temperature is a property of WHERE
     * a parcel of gas has been, not of how old it is. Colour keyed to age is the
     * single most common tell in procedural fire: a lick flung sideways into cold
     * air and one that shot straight up the core come out the same shade, so the
     * flame reads as an orange shape being wobbled rather than as gas burning.
     *
     * So it gets carried through the advection instead, and only two things happen
     * to it:
     *
     *   `burnRate`  — degrees per second released while there's still fuel to burn,
     *                 for `burnTime` of the particle's life. This is why the
     *                 brightest part of a fire sits a little ABOVE the wood, with a
     *                 darker pyrolysis gap under it, rather than being brightest
     *                 right where it's emitted.
     *   `mixing`    — how fast entrained cold air dilutes it away again, per second.
     *                 Faster out at the edges, where the gas meets air directly, and
     *                 faster in strong shear; slowest in the core, which is shielded
     *                 by the hot gas around it. That difference is the whole point:
     *                 it's what makes the core white and the strays dark red.
     */
    burnRate: number;
    burnTime: number;
    mixing: number;
    /**
     * Exponent turning temperature into brightness.
     *
     * Luminosity of the soot continuum goes as roughly T^4, which is why the core
     * of a real fire blows out a camera while the tips barely register. Straight
     * physics is too brutal without tone mapping — everything but the core
     * disappears — so this is the dial for how far to push it.
     */
    glowFalloff: number;
    /** Spatial frequency of the curl field. Higher = finer, busier eddies. */
    curlScale: number;
    /** How fast the curl field drifts upward, so the fire carries its eddies with it. */
    curlScroll: number;
    /**
     * How fast the eddies themselves turn over, in radians per second of the
     * field's own phase — see `flameCurl` in src/curl.ts. Drifting a frozen
     * pattern past the fire gives you motion without change; this is what makes
     * a tongue appear, stretch and break up rather than just slide.
     */
    curlEvolve: number;
    /** Splat size at the fattest point of a particle's life. */
    size: number;
    /** How far each splat is stretched along its own velocity. */
    stretch: number;
    /**
     * How unevenly the bed burns, 0..1 — the contrast between its best patch and
     * its worst. A real fire doesn't burn at one rate all over: fuel is piled
     * unevenly, so some patches throw tall bright flame while others sit low and
     * dark, and which is which drifts over time.
     *
     * This is the main dial for how ragged the fire looks, and specifically for
     * how LOW the fire's low end gets, because in this model a patch's fuel sets
     * its temperature, its temperature sets its buoyancy, and so a dim patch is
     * also a SHORT one. At 0.82 the best patches peak white and climb ~1.0 units
     * while the worst peak dark red and die at ~0.2, just licking the logs.
     *
     * It costs almost nothing in overall brightness (~5% between 0.7 and 0.82),
     * because heat enters as a threshold: raising this mostly deepens patches that
     * were already unlit rather than dimming the ones that are burning.
     */
    unevenness: number;
    /**
     * BLOOM, faked in the generator.
     *
     * Real bloom is scattering in the lens and in your eye: a bright source
     * convolved with a wide, very low kernel. The usual way to get it is an HDR
     * render target and a fullscreen pass — but Spark draws splats with its own
     * raw shaders, so three's tone mapping never reaches them, and a post chain
     * would re-grade the whole baked scene along with the fire.
     *
     * So instead a second, sparser population of the same burning gas is drawn
     * big and almost transparent. Additive premultiplied blending does the
     * convolution for free, it costs one extra advection per glow splat rather
     * than a float buffer and a full-screen pass, and it touches nothing outside
     * this file.
     *
     * `glowSharpness` is what keeps it a halo rather than a haze — it has to hug
     * the white gas only. At 4.0, gas at temp 0.8 contributes 0.41 and gas at 0.5
     * contributes 0.06.
     */
    glowCount: number;
    glowSize: number;
    glowOpacity: number;
    glowSharpness: number;
    /**
     * Per-splat alpha, and it wants to be LOW.
     *
     * Fire is emissive: two overlapping tongues should add up, not hide each
     * other. Spark blends premultiplied, so a bright colour at a small alpha
     * approximates additive blending — each splat contributes light rather than
     * painting over what's behind it. Raise this and the flame stops being fire
     * and becomes an orange lozenge.
     */
    opacity: number;
};

// Many small, faint splats rather than few large ones. Flame is a thing you see
// THROUGH — the structure comes from thousands of thin overlapping tongues
// accumulating, and big fat splats just average into an orange blob.
// Many small, faint, short-lived splats. Flame is a thing you see THROUGH.
export const DEFAULT_FLAME: FlameParams = {
    count: 62000,
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
    glowCount: 6000,
    glowSize: 0.1,
    glowOpacity: 0.022,
    glowSharpness: 4.0,
};

// Euler steps used to advect each particle from birth to now. Four was plenty
// while the walk only had to produce a position — the field is smooth and the
// error just reads as a slightly different eddy. Temperature is less forgiving:
// it peaks inside the first third of the life, and at four steps only one sample
// lands in that window, so the peak comes out mushy.
const FLAME_STEPS = 6;
const FLAME_STEPS_GLSL = /* glsl */ `const int FLAME_STEPS = ${FLAME_STEPS};`;

// Blackbody-ish ramp, indexed by temperature. Colour is the strongest cue that
// this is burning rather than just glowing.
const COLOR_HOT = new THREE.Vector3(1.0, 0.98, 0.86); // near-white, in the reaction zone
const COLOR_MID = new THREE.Vector3(1.0, 0.42, 0.06); // orange, mid-tongue
const COLOR_COOL = new THREE.Vector3(0.42, 0.03, 0.005); // deep red, going out

export type Flame = {
    /** The generator node — add to your scene. */
    object: SplatGenerator;
    /** Push this frame's furnace heat in (0 = embers, 1 = roaring). */
    setHeat(heat: number): void;
};

export function initFlame(params: Partial<FlameParams> = {}): Flame {
    const p: FlameParams = { ...DEFAULT_FLAME, ...params };

    const uOrigin = d.dynoVec3(new THREE.Vector3(FLAME_ORIGIN[0], FLAME_ORIGIN[1], FLAME_ORIGIN[2]));
    const uBaseRadius = d.dynoFloat(p.baseRadius);
    const uRate = d.dynoFloat(p.rate);
    const uRiseSpeed = d.dynoFloat(p.riseSpeed);
    const uTurbulence = d.dynoFloat(p.turbulence);
    const uInflow = d.dynoFloat(p.inflow);
    const uBurnRate = d.dynoFloat(p.burnRate);
    const uBurnTime = d.dynoFloat(p.burnTime);
    const uMixing = d.dynoFloat(p.mixing);
    const uGlowFalloff = d.dynoFloat(p.glowFalloff);
    const uCurlScale = d.dynoFloat(p.curlScale);
    const uCurlScroll = d.dynoFloat(p.curlScroll);
    const uCurlEvolve = d.dynoFloat(p.curlEvolve);
    const uSize = d.dynoFloat(p.size);
    const uStretch = d.dynoFloat(p.stretch);
    const uUneven = d.dynoFloat(p.unevenness);
    const uOpacity = d.dynoFloat(p.opacity);
    // Splats at or above this index are bloom rather than flame body.
    const uBodyCount = d.dynoInt(p.count);
    const uGlowSize = d.dynoFloat(p.glowSize);
    const uGlowOpacity = d.dynoFloat(p.glowOpacity);
    const uGlowSharpness = d.dynoFloat(p.glowSharpness);
    const uHeat = d.dynoFloat(0);
    const uTime = d.dynoFloat(0);

    const object = new SplatGenerator({
        numSplats: p.count + p.glowCount,
        generator: d.dynoBlock(
            { index: 'int' },
            { gsplat: d.Gsplat },
            ({ index }) => {
                if (!index) throw new Error('flame generator: no index input');

                const node = d.dyno({
                    inTypes: {
                        index: 'int',
                        origin: 'vec3',
                        baseRadius: 'float',
                        rate: 'float',
                        riseSpeed: 'float',
                        turbulence: 'float',
                        inflow: 'float',
                        burnRate: 'float',
                        burnTime: 'float',
                        mixing: 'float',
                        glowFalloff: 'float',
                        curlScale: 'float',
                        curlScroll: 'float',
                        curlEvolve: 'float',
                        size: 'float',
                        stretch: 'float',
                        uneven: 'float',
                        opacity: 'float',
                        bodyCount: 'int',
                        glowSize: 'float',
                        glowOpacity: 'float',
                        glowSharpness: 'float',
                        heat: 'float',
                        time: 'float',
                    },
                    outTypes: { gsplat: d.Gsplat },
                    inputs: {
                        index,
                        origin: uOrigin,
                        baseRadius: uBaseRadius,
                        rate: uRate,
                        riseSpeed: uRiseSpeed,
                        turbulence: uTurbulence,
                        inflow: uInflow,
                        burnRate: uBurnRate,
                        burnTime: uBurnTime,
                        mixing: uMixing,
                        glowFalloff: uGlowFalloff,
                        curlScale: uCurlScale,
                        curlScroll: uCurlScroll,
                        curlEvolve: uCurlEvolve,
                        size: uSize,
                        stretch: uStretch,
                        uneven: uUneven,
                        opacity: uOpacity,
                        bodyCount: uBodyCount,
                        glowSize: uGlowSize,
                        glowOpacity: uGlowOpacity,
                        glowSharpness: uGlowSharpness,
                        heat: uHeat,
                        time: uTime,
                    },
                    globals: () => [d.defineGsplat, CURL_GLSL, FLAME_STEPS_GLSL],
                    statements: ({ inputs, outputs }) => {
                        const g = outputs.gsplat;
                        const i = inputs;
                        return d.unindentLines(`
                            vec4 rand = flameHash(${i.index});
                            float seed = rand.w;

                            // Age sweeps 0..1 and wraps — birth to death with no
                            // state. Rates vary per particle so nothing pulses in
                            // unison.
                            float rate = ${i.rate} * (0.7 + rand.x * 0.6);
                            float age = fract(seed * 7.13 + ${i.time} * rate);
                            float elapsed = age / rate; // seconds since this particle was born

                            // Picked up anywhere on the fuel bed. No lanes, no
                            // assigned tongues: structure has to EMERGE from the
                            // flow, because a particle tied to a lane is a rope and
                            // ropes are what makes a fire look stringy.
                            float ang = rand.y * 6.2831853;
                            float radius = sqrt(rand.z) * ${i.baseRadius};
                            vec3 pos = ${i.origin} + vec3(cos(ang) * radius, 0.0, sin(ang) * radius);

                            // How well this patch of the bed is burning. Three
                            // plane waves at unrelated orientations and drift rates,
                            // beating into a quasi-periodic field — no grid, no
                            // repeat.
                            //
                            // The FREQUENCIES are the whole point. The pair this
                            // replaces fitted less than ONE cycle across a 0.68-unit
                            // bed, so "unevenness" wasn't patchy at all: it was a
                            // single smooth gradient that slowly drifted, and the bed
                            // brightened and dimmed as one. That is why a flare-up
                            // read as the entire cone inflating rather than as a
                            // patch throwing a tongue. These fit 2-4 cycles across it.
                            float bed = sin(dot(pos.xz, vec2(19.0, 13.0)) + ${i.time} * 0.8)
                                      + 0.7 * sin(dot(pos.xz, vec2(-11.0, 27.0)) + ${i.time} * 0.55 + 2.1)
                                      + 0.5 * sin(dot(pos.xz, vec2(33.0, -21.0)) - ${i.time} * 1.1 + 4.3);
                            bed *= 0.4545;

                            // Heat enters here as a THRESHOLD rather than a
                            // multiplier: stoking a fire spreads the burning AREA
                            // over the bed, it doesn't raise every patch in
                            // proportion. A multiplier is precisely what makes a
                            // flare-up look like the same shape scaled up — this way
                            // a stoke reads as new patches catching, and a dying fire
                            // retreats to its few best ones.
                            float lit = smoothstep(-0.5, 0.5, bed + 1.3 * (${i.heat} - 0.45));
                            float fuel = 1.0 - ${i.uneven} * (1.0 - lit);

                            // A lumpy footprint. What this replaces was a clean
                            // function of radius alone — an axisymmetric cone
                            // generator, scaling every particle's temperature by its
                            // distance from one axis, always. Letting the bed's reach
                            // vary with direction (and drift) gives it a ragged edge
                            // instead of a circle.
                            float lobe = 0.75 + 0.35 * sin(ang * 3.0 + ${i.time} * 0.25)
                                              + 0.2 * sin(ang * 5.0 - ${i.time} * 0.17 + 1.3);
                            fuel *= 1.0 - 0.4 * min(radius / max(${i.baseRadius} * lobe, 1e-4), 1.0);

                            // Temperature, 1.0 = as hot as this flame gets. It
                            // starts LOW: what leaves wood is cool pyrolysis gas,
                            // and it has to burn before it glows.
                            float temp = fuel * 0.35;

                            // ADVECTION. Walk the particle through the velocity
                            // field from birth to now, a few Euler steps at a time,
                            // carrying its temperature along with it.
                            //
                            // This is the difference between a fluid and a bundle of
                            // strings. Sampling the field once and displacing by it
                            // teleports a particle around as the field changes; only
                            // integrating ALONG the path makes it follow the flow —
                            // and because the curl field is divergence-free and
                            // spatially coherent, neighbouring particles stay
                            // neighbours and tongues form on their own.
                            vec3 vel = vec3(0.0);
                            float dt = elapsed / float(FLAME_STEPS);
                            for (int k = 0; k < FLAME_STEPS; k++) {
                                // Fraction of this particle's FULL lifetime, not of
                                // the walk so far. Those are different numbers and
                                // only the first one is a clock: parameterise the
                                // ramps by progress-to-now and the whole walk just
                                // rescales as the particle ages, which collapses any
                                // profile you write into its own average. An
                                // acceleration written that way produces a constant
                                // speed instead.
                                float through = ((float(k) + 0.5) / float(FLAME_STEPS)) * age;

                                // WHEN this step happened, in wall-clock seconds.
                                // The field changes, so a particle has to be walked
                                // through the field AS IT WAS at each point on the
                                // way — that's a pathline. Using the current field
                                // for every step instead advects the whole
                                // population through one frozen snapshot, which is
                                // the other half of why fire looks like a deforming
                                // shape rather than something flowing.
                                float tStep = ${i.time} - elapsed + through / rate;

                                vec2 radial = pos.xz - ${i.origin}.xz;
                                float distFromAxis = length(radial);

                                vec3 field = pos * ${i.curlScale} - vec3(0.0, tStep * ${i.curlScroll}, 0.0);
                                vec3 curl = flameCurl(field, tStep * ${i.curlEvolve}) * ${i.turbulence};

                                // Turbulence grows as the particle rises and slows.
                                //
                                // The FLOOR matters more than the ramp, and it has
                                // to be high. Young gas is barely displaced anyway —
                                // it has had almost no time for any velocity to act
                                // over — so a ramp starting near zero doesn't make
                                // the base tight, it just deletes the stirring from
                                // the part of the flame you can actually see, which
                                // is exactly where temperature peaks. Starve that and
                                // the fire comes out as a smooth upright cone.
                                curl *= 0.56 + 0.9 * through;

                                // Cool gas has less of its own momentum, so the field
                                // gets more of a grip on it. This is what gives the
                                // dark-red stragglers a life of their own while the
                                // hot core still drives coherently upward.
                                curl *= 1.35 - 0.45 * temp;

                                // COMBUSTION. Heat goes in while there's still fuel
                                // left in the parcel, which is why a fire is
                                // brightest a little ABOVE the wood with a darker
                                // gap beneath — the gas has to travel before it's
                                // finished burning.
                                temp += ${i.burnRate} * fuel * dt
                                      * (1.0 - smoothstep(0.0, max(${i.burnTime}, 1e-3), through));

                                // MIXING. Entrained cold air dilutes the parcel, and
                                // this is where the structure in the colour comes
                                // from, because it is emphatically not uniform:
                                //
                                //   - out at the edge a parcel meets cold air
                                //     directly; in the core it's shielded by the hot
                                //     gas around it, so the core stays white while
                                //     anything flung clear goes dark red
                                //   - strong shear folds cold air in faster
                                //   - and it accumulates, so old gas cools fastest
                                float exposed = clamp(distFromAxis / max(${i.baseRadius}, 1e-4), 0.0, 1.6);
                                float shear = length(curl) / max(${i.turbulence}, 1e-4);
                                float mixRate = ${i.mixing}
                                              * (0.3 + 1.2 * exposed + 0.8 * shear)
                                              * (0.3 + 1.6 * through);
                                // exp() rather than a linear step: decay is the one
                                // thing Euler gets badly wrong at six steps, and the
                                // closed form is both exact and unconditionally
                                // stable.
                                temp = min(temp * exp(-mixRate * dt), 1.0);

                                // Buoyancy IS temperature — hot gas rises because
                                // it's less dense than the air around it. Driving it
                                // from temp rather than from a ramp over the life is
                                // what stops a tongue that has already gone cold from
                                // carrying on up the screen anyway.
                                //
                                // Note there is no heat term here. A global
                                // multiplier on rise speed lifts every living
                                // particle at once, so a stoke inflates the whole
                                // flame in lockstep — the same mistake that made the
                                // smoke lurch (see src/smoke.ts). Heat reaches the
                                // flame through the bed instead, one patch at a time.
                                float buoy = ${i.riseSpeed} * temp;

                                // Entrainment: the fire drags air inward to feed
                                // itself, hardest low down where it's burning
                                // hottest. This is what necks the column instead of
                                // letting it spray.
                                vec3 draft = vec3(0.0);
                                if (distFromAxis > 1e-4) {
                                    vec2 inward = -radial / distFromAxis;
                                    draft = vec3(inward.x, 0.0, inward.y)
                                          * ${i.inflow} * (1.0 - 0.7 * through)
                                          * min(distFromAxis / max(${i.baseRadius}, 1e-4), 1.5);
                                }

                                vel = vec3(0.0, buoy, 0.0) + curl + draft;
                                pos += vel * dt;
                            }

                            vec3 center = pos;

                            // Swell then collapse over the life.
                            float swell = pow(sin(age * 3.14159), 0.55 + rand.y * 1.1);
                            float scale = ${i.size} * swell * (0.6 + rand.x * 0.7) * (0.7 + 0.5 * ${i.heat});

                            // Colour reads the temperature it ended up at, so two
                            // particles the same age can be white and dark red.
                            vec3 col = temp > 0.5
                                ? mix(vec3(${COLOR_MID.x}, ${COLOR_MID.y}, ${COLOR_MID.z}),
                                      vec3(${COLOR_HOT.x}, ${COLOR_HOT.y}, ${COLOR_HOT.z}), (temp - 0.5) / 0.5)
                                : mix(vec3(${COLOR_COOL.x}, ${COLOR_COOL.y}, ${COLOR_COOL.z}),
                                      vec3(${COLOR_MID.x}, ${COLOR_MID.y}, ${COLOR_MID.z}), temp / 0.5);

                            // So does brightness, steeply — see \`glowFalloff\`. The
                            // dark base and the fading tips now come out of the
                            // temperature curve rather than being drawn by hand; the
                            // envelope is only here to guarantee a clean zero at the
                            // wrap, where age snaps back to newborn.
                            float alpha = pow(max(temp, 0.0), ${i.glowFalloff});
                            alpha *= smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.7, 1.0, age));
                            alpha *= ${i.opacity} * (0.55 + 0.6 * ${i.heat});

                            ${g}.center = center;
                            ${g}.flags = GSPLAT_FLAG_ACTIVE;
                            ${g}.index = ${i.index};

                            if (${i.index} >= ${i.bodyCount}) {
                                // BLOOM. Same gas, same walk — drawn wide and almost
                                // transparent so the overlap does the blurring. Round,
                                // because a scattering halo has no direction: it is
                                // not a picture of the flame, it's the light that got
                                // smeared on the way to you.
                                float halo = ${i.glowSize} * (0.7 + rand.x * 0.6);
                                float ga = pow(max(temp, 0.0), ${i.glowSharpness})
                                         * ${i.glowOpacity}
                                         * smoothstep(0.0, 0.1, age)
                                         * (1.0 - smoothstep(0.55, 1.0, age))
                                         * (0.55 + 0.6 * ${i.heat});
                                ${g}.scales = vec3(halo);
                                ${g}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
                                ${g}.rgba = vec4(col, ga);
                            } else {
                                ${g}.scales = vec3(scale, scale * ${i.stretch}, scale);
                                // Stretch along the particle's actual velocity, which
                                // integration hands us for free. A splat left pointing
                                // at the sky while its flow leans is what looks stiff.
                                ${g}.quaternion = flameAlignY(normalize(vel + vec3(0.0, 1e-4, 0.0)));
                                ${g}.rgba = vec4(col, alpha);
                            }
                        `);
                    },
                });

                return { gsplat: node.outputs.gsplat };
            },
            { globals: () => [d.defineGsplat] },
        ),
        update: ({ time }) => {
            uTime.value = time;
            // Same contract as any animated Spark geometry: no version bump, no
            // regeneration, and the flame freezes the moment the camera stops.
            object.updateVersion();
        },
    });

    // Same reasoning as the dust: the flame must not intercept measuring clicks.
    object.raycast = () => {};

    return {
        object,
        setHeat(heat) {
            uHeat.value = THREE.MathUtils.clamp(heat, 0, 1);
        },
    };
}

/** Convenience: drive the flame straight from the shared furnace signal. */
export function updateFlame(flame: Flame, furnace: Furnace): void {
    flame.setHeat(furnaceHeat(furnace));
}
