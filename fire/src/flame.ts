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
 * swell, cool through a blackbody ramp and die, continuously.
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
    /** Upward velocity from buoyancy, in world units per second. Sets how tall the fire gets. */
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
    /** Spatial frequency of the curl field. Higher = finer, busier eddies. */
    curlScale: number;
    /** How fast the curl field drifts upward, so the fire carries its eddies with it. */
    curlScroll: number;
    /** Splat size at the fattest point of a particle's life. */
    size: number;
    /** How far each splat is stretched along its own velocity. */
    stretch: number;
    /**
     * How unevenly the bed burns, 0..1. A real fire doesn't burn at one rate all
     * over: fuel is piled unevenly, so some patches throw tall bright flame while
     * others sit low and dark, and which is which drifts over time.
     */
    unevenness: number;
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
    count: 52000,
    baseRadius: 0.34,
    rate: 1.4,
    riseSpeed: 2.3,
    turbulence: 0.95,
    inflow: 0.42,
    curlScale: 2.6,
    curlScroll: 1.1,
    size: 0.015,
    stretch: 3.2,
    unevenness: 0.5,
    opacity: 0.22,
};

// Blackbody-ish ramp: a flame is white-hot where it's fed and cools as it climbs.
// Colour is the strongest cue that this is burning rather than just glowing.
// Euler steps used to advect each particle from birth to now. Four is plenty:
// the field is smooth, and the error just reads as a slightly different eddy.
const FLAME_STEPS = 4;
const FLAME_STEPS_GLSL = /* glsl */ `const int FLAME_STEPS = ${FLAME_STEPS};`;

const COLOR_HOT = new THREE.Vector3(1.0, 0.98, 0.86); // near-white, at the coals
const COLOR_MID = new THREE.Vector3(1.0, 0.42, 0.06); // orange, mid-tongue
const COLOR_COOL = new THREE.Vector3(0.42, 0.03, 0.005); // deep red, at the tip

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
    const uCurlScale = d.dynoFloat(p.curlScale);
    const uCurlScroll = d.dynoFloat(p.curlScroll);
    const uSize = d.dynoFloat(p.size);
    const uStretch = d.dynoFloat(p.stretch);
    const uUneven = d.dynoFloat(p.unevenness);
    const uOpacity = d.dynoFloat(p.opacity);
    const uHeat = d.dynoFloat(0);
    const uTime = d.dynoFloat(0);

    const object = new SplatGenerator({
        numSplats: p.count,
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
                        curlScale: 'float',
                        curlScroll: 'float',
                        size: 'float',
                        stretch: 'float',
                        uneven: 'float',
                        opacity: 'float',
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
                        curlScale: uCurlScale,
                        curlScroll: uCurlScroll,
                        size: uSize,
                        stretch: uStretch,
                        uneven: uUneven,
                        opacity: uOpacity,
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

                            // How well this patch of the bed is burning. Two slow
                            // waves at unrelated rates beat against each other, so
                            // hot patches form, drift and die without repeating.
                            float fuel = sin(pos.x * 7.3 + ${i.time} * 0.33) * sin(pos.z * 5.1 - ${i.time} * 0.21 + 1.7);
                            fuel = mix(1.0, 0.45 + 0.55 * fuel, ${i.uneven});
                            fuel *= mix(1.0, 0.55, radius / max(${i.baseRadius}, 1e-4));

                            // ADVECTION. Walk the particle through the velocity
                            // field from birth to now, a few Euler steps at a time.
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
                                float through = (float(k) + 0.5) / float(FLAME_STEPS);

                                // Buoyancy: builds as the gas heats, fades as it
                                // cools and slows near the top.
                                float buoy = ${i.riseSpeed} * fuel * (0.45 + 1.25 * ${i.heat})
                                           * (0.35 + 1.3 * through) * (1.0 - 0.45 * through * through);

                                vec3 field = pos * ${i.curlScale} - vec3(0.0, ${i.time} * ${i.curlScroll}, 0.0);
                                vec3 curl = flameCurl(field) * ${i.turbulence};

                                // Turbulence has little grip right at the fuel and
                                // takes over as the particle rises.
                                curl *= 0.2 + 0.95 * through;

                                // Entrainment: the fire drags air inward to feed
                                // itself, hardest low down where it's burning
                                // hottest. This is what necks the column instead of
                                // letting it spray.
                                vec2 radial = pos.xz - ${i.origin}.xz;
                                float distFromAxis = length(radial);
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

                            // Cool as it climbs.
                            vec3 col = age < 0.42
                                ? mix(vec3(${COLOR_HOT.x}, ${COLOR_HOT.y}, ${COLOR_HOT.z}),
                                      vec3(${COLOR_MID.x}, ${COLOR_MID.y}, ${COLOR_MID.z}), age / 0.42)
                                : mix(vec3(${COLOR_MID.x}, ${COLOR_MID.y}, ${COLOR_MID.z}),
                                      vec3(${COLOR_COOL.x}, ${COLOR_COOL.y}, ${COLOR_COOL.z}), (age - 0.42) / 0.58);

                            // In fast, out slow — flames flare and then thin away.
                            float alpha = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.35, 1.0, age));
                            alpha *= ${i.opacity} * (0.35 + 0.9 * ${i.heat}) * (0.3 + 0.9 * fuel);
                            // Hot merged glow down in the fuel, thinning as it climbs.
                            alpha *= 1.0 + 0.7 * (1.0 - smoothstep(0.0, 0.22, age));

                            ${g}.center = center;
                            ${g}.flags = GSPLAT_FLAG_ACTIVE;
                            ${g}.scales = vec3(scale, scale * ${i.stretch}, scale);
                            ${g}.index = ${i.index};
                            // Stretch along the particle's actual velocity, which
                            // integration hands us for free. A splat left pointing at
                            // the sky while its flow leans is what looks stiff.
                            ${g}.quaternion = flameAlignY(normalize(vel + vec3(0.0, 1e-4, 0.0)));
                            ${g}.rgba = vec4(col, alpha);
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
