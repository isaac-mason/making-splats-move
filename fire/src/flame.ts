import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { CURL_GLSL } from './curl';
import { type Fire, fireHeat } from './fire';
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
 * campfire rather than on top of the picture of one — they sort and blend with the
 * scene's own splats, so the logs and stones occlude the flame exactly as they
 * should.
 *
 * Stateless, like the dust example: hash the splat index for a stable seed, then
 * evaluate a closed-form function of (seed, time). A lifetime would normally mean
 * tracking birth and death per particle, so instead age is itself a fract():
 *
 *     age = fract(seed + time * rate)
 *
 * Every particle sweeps 0..1 forever, wrapping back to newborn, and the seed
 * spreads the population evenly across all ages.
 */

export type FlameParams = {
    /** Number of splats in the flame. They're recycled continuously, so this is the population. */
    count: number;
    /** Radius of the fuel bed particles are picked up from, in world units. */
    baseRadius: number;
    /** Lifetimes per second. Fire is fast — a lick of flame exists for well under a second. */
    rate: number;
    /**
     * Buoyancy per unit of temperature, in world units per second — how tall the
     * fire gets. Keyed to temperature rather than age, so a tongue that goes cold
     * early stops climbing on its own, and rise and colour can't disagree.
     */
    riseSpeed: number;
    /** Strength of the curl field, in world units per second. The only source of structure. */
    turbulence: number;
    /**
     * Inward draft, in world units per second. A fire pulls air in at its base,
     * which is why flame necks INWARD as it climbs. Without it the flame sprays
     * outward and reads as a jet.
     */
    inflow: number;
    /**
     * TEMPERATURE. 1.0 is as hot as the flame gets (near-white); 0 is ambient air.
     *
     * Colour, brightness and rise all read temperature, and temperature depends on
     * WHERE a parcel has been, not how old it is. Colour keyed to age is the
     * classic tell of procedural fire: a lick flung into cold air comes out the
     * same shade as one up the core. So temperature is carried through the
     * advection, and only two things change it:
     *
     *   `burnRate`  — heat released per second while there's fuel, for the first
     *                 `burnTime` of the life. Why a fire is brightest a little ABOVE
     *                 the wood.
     *   `mixing`    — how fast entrained cold air dilutes it, per second. Fastest at
     *                 the edges and in shear, slowest in the shielded core — which
     *                 is what makes the core white and the strays dark red.
     */
    burnRate: number;
    burnTime: number;
    mixing: number;
    /**
     * Exponent turning temperature into brightness. Soot glows as roughly T^4, but
     * without tone mapping that leaves nothing but the core, so this is how far to
     * push toward it.
     */
    glowFalloff: number;
    /** Spatial frequency of the curl field. Higher = finer, busier eddies. */
    curlScale: number;
    /** How fast the curl field drifts upward, so the fire carries its eddies with it. */
    curlScroll: number;
    /**
     * How fast the eddies themselves turn over (see `flameCurl` in src/curl.ts),
     * so a tongue appears, stretches and breaks up rather than just sliding past.
     */
    curlEvolve: number;
    /** Splat size at the fattest point of a particle's life. */
    size: number;
    /** How far each splat is stretched along its own velocity. */
    stretch: number;
    /**
     * How unevenly the bed burns, 0..1 — the contrast between its best patch and
     * its worst. The main dial for how ragged the fire looks: fuel sets
     * temperature and temperature sets buoyancy, so a dim patch is also a SHORT
     * one. At 0.82 the best patches peak white at ~1.0 units and the worst die dark
     * red at ~0.2, just licking the logs.
     */
    unevenness: number;
    /**
     * BLOOM, faked in the generator. A post pass would re-grade the whole baked
     * scene along with the fire, so instead a second, sparser population of the
     * same gas is drawn big and almost transparent, and the blending does the blur.
     *
     * `glowSharpness` keeps it a halo rather than a haze by hugging the white gas:
     * at 4.0, temp 0.8 contributes 0.41 and temp 0.5 contributes 0.06.
     */
    glowCount: number;
    glowSize: number;
    glowOpacity: number;
    glowSharpness: number;
    /**
     * Per-splat alpha, and it wants to be LOW: many faint tongues accumulate into
     * fire, while opaque ones hide each other and become an orange lozenge.
     */
    opacity: number;
};

// Many small, faint, short-lived splats. Flame is a thing you see THROUGH, and
// big fat splats just average into an orange blob.
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

// Euler steps used to advect each particle from birth to now. Temperature peaks
// in the first third of the life, and fewer steps leave that peak mushy.
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
    /** Push this frame's fire heat in (0 = embers, 1 = roaring). */
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

                            // How well this patch of the bed is burning: three
                            // plane waves at unrelated orientations and rates.
                            // They fit 2-4 cycles across the bed — any coarser and
                            // the bed brightens and dims as one, so a flare-up
                            // inflates the whole cone instead of throwing a tongue.
                            float bed = sin(dot(pos.xz, vec2(19.0, 13.0)) + ${i.time} * 0.8)
                                      + 0.7 * sin(dot(pos.xz, vec2(-11.0, 27.0)) + ${i.time} * 0.55 + 2.1)
                                      + 0.5 * sin(dot(pos.xz, vec2(33.0, -21.0)) - ${i.time} * 1.1 + 4.3);
                            bed *= 0.4545;

                            // Heat is a THRESHOLD, not a multiplier: a stoke reads
                            // as new patches catching rather than the same shape
                            // scaled up, and a dying fire retreats to its best ones.
                            float lit = smoothstep(-0.5, 0.5, bed + 1.3 * (${i.heat} - 0.45));
                            float fuel = 1.0 - ${i.uneven} * (1.0 - lit);

                            // A lumpy footprint: the bed's reach varies with
                            // direction and drifts, so its edge is ragged rather
                            // than a circle.
                            float lobe = 0.75 + 0.35 * sin(ang * 3.0 + ${i.time} * 0.25)
                                              + 0.2 * sin(ang * 5.0 - ${i.time} * 0.17 + 1.3);
                            fuel *= 1.0 - 0.4 * min(radius / max(${i.baseRadius} * lobe, 1e-4), 1.0);

                            // Temperature, 1.0 = as hot as this flame gets. It
                            // starts LOW: what leaves wood is cool pyrolysis gas,
                            // and it has to burn before it glows.
                            float temp = fuel * 0.35;

                            // ADVECTION. Walk the particle through the velocity
                            // field from birth to now, carrying its temperature.
                            // Displacing by one field sample teleports particles as
                            // the field changes; integrating ALONG the path keeps
                            // neighbours together, so tongues form on their own.
                            vec3 vel = vec3(0.0);
                            float dt = elapsed / float(FLAME_STEPS);
                            for (int k = 0; k < FLAME_STEPS; k++) {
                                // Fraction of the FULL lifetime, not of the walk so
                                // far. Keyed to the walk, every ramp rescales as the
                                // particle ages and collapses into its own average.
                                float through = ((float(k) + 0.5) / float(FLAME_STEPS)) * age;

                                // WHEN this step happened, so the walk sees the field
                                // AS IT WAS (a pathline). One frozen snapshot for every
                                // step makes the fire a deforming shape, not a flow.
                                float tStep = ${i.time} - elapsed + through / rate;

                                vec2 radial = pos.xz - ${i.origin}.xz;
                                float distFromAxis = length(radial);

                                vec3 field = pos * ${i.curlScale} - vec3(0.0, tStep * ${i.curlScroll}, 0.0);
                                vec3 curl = flameCurl(field, tStep * ${i.curlEvolve}) * ${i.turbulence};

                                // Turbulence grows as the particle rises. The high
                                // floor matters: young gas is barely displaced anyway,
                                // and starving it leaves a smooth upright cone exactly
                                // where temperature peaks.
                                curl *= 0.56 + 0.9 * through;

                                // Cool gas has less momentum, so the field grips it
                                // harder: dark-red stragglers wander while the hot
                                // core drives upward.
                                curl *= 1.35 - 0.45 * temp;

                                // COMBUSTION. Heat goes in while there's fuel left, so
                                // the gas travels before it's done burning.
                                temp += ${i.burnRate} * fuel * dt
                                      * (1.0 - smoothstep(0.0, max(${i.burnTime}, 1e-3), through));

                                // MIXING. Entrained cold air dilutes the parcel —
                                // faster at the exposed edge, in shear, and as it
                                // ages. This is where the colour's structure comes from.
                                float exposed = clamp(distFromAxis / max(${i.baseRadius}, 1e-4), 0.0, 1.6);
                                float shear = length(curl) / max(${i.turbulence}, 1e-4);
                                float mixRate = ${i.mixing}
                                              * (0.3 + 1.2 * exposed + 0.8 * shear)
                                              * (0.3 + 1.6 * through);
                                // exp() rather than an Euler step: exact, and stable
                                // at any step size.
                                temp = min(temp * exp(-mixRate * dt), 1.0);

                                // Buoyancy IS temperature. No heat term on purpose: a
                                // global multiplier lifts every particle at once and
                                // the flame inflates in lockstep. Heat reaches it
                                // through the bed instead, one patch at a time.
                                float buoy = ${i.riseSpeed} * temp;

                                // Entrainment, hardest low down: necks the column
                                // instead of letting it spray.
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
                            // envelope only guarantees a clean zero at the wrap.
                            float alpha = pow(max(temp, 0.0), ${i.glowFalloff});
                            alpha *= smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.7, 1.0, age));
                            alpha *= ${i.opacity} * (0.55 + 0.6 * ${i.heat});

                            ${g}.center = center;
                            ${g}.flags = GSPLAT_FLAG_ACTIVE;
                            ${g}.index = ${i.index};

                            if (${i.index} >= ${i.bodyCount}) {
                                // BLOOM. Same gas, same walk, drawn wide and faint.
                                // Round, because scattered light has no direction.
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
                                // the walk hands us for free.
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

    // Like the embers: the flame must not intercept the debug panel's measuring clicks.
    object.raycast = () => {};

    return {
        object,
        setHeat(heat) {
            uHeat.value = THREE.MathUtils.clamp(heat, 0, 1);
        },
    };
}

/** Convenience: drive the flame straight from the shared fire signal. */
export function updateFlame(flame: Flame, fire: Fire): void {
    flame.setHeat(fireHeat(fire));
}
