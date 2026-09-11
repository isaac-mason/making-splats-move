import { dyno, type GsplatModifier, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { type Furnace, furnaceHeat } from './furnace';
import { LIGHT_ORIGIN } from './lighting';

// Heat shimmer — a Spark world-modifier. Instead of a screen-space filter, this
// jiggles the actual scene splats' world positions inside a sphere around the
// fire: an upward-scrolling noise displacement whose strength falls off from
// the core out to the radius. The geometry itself wobbles like air over a flame,
// so it reads as "this thing is dangerously hot" from any angle.

const { dynoBlock, dynoFloat, dynoVec3, defineGsplat, unindentLines } = dyno;

// World-space radius of the hot zone around the fire.
const RADIUS = 0.85;

// Max world-space displacement (metres) at the core. Small — shimmer is a subtle bend.
const STRENGTH = 0.012;

// World-space frequency of the wobble. Higher = finer ripples.
const SCALE = 3.4;

// The noise tiles every NOISE_PERIOD units, so scrolling it by a whole number of
// periods loops seamlessly — and keeps the sample coordinates bounded. (The old
// version scrolled an infinite field by an ever-growing time, which drifted into
// float32's bad range and made the shimmer pop over time.) Loops every LOOP_SECONDS.
const NOISE_PERIOD = 8;
const LOOP_SECONDS = 10;

// Tileable value noise: the lattice corners wrap at HEAT_PERIOD so the field
// repeats, and the hash avoids large-argument sin() (the precision culprit).
const NOISE_GLSL = /* glsl */ `
    const float HEAT_PERIOD = ${NOISE_PERIOD.toFixed(1)};

    float heatHash(vec2 p) {
        p = fract(p * vec2(0.3183099, 0.3678794) + 0.1);
        p += dot(p, p + 27.13);
        return fract(p.x * p.y);
    }
    float heatNoise(vec2 x) {
        vec2 i = floor(x);
        vec2 f = fract(x);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = heatHash(mod(i,                  HEAT_PERIOD));
        float b = heatHash(mod(i + vec2(1.0, 0.0), HEAT_PERIOD));
        float c = heatHash(mod(i + vec2(0.0, 1.0), HEAT_PERIOD));
        float d = heatHash(mod(i + vec2(1.0, 1.0), HEAT_PERIOD));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
`;

export type Heat = {
    /** The world-modifier dyno graph — assign to `splat.worldModifier`. */
    modifier: GsplatModifier;
    /** Hot-zone centre (world space). Mutate `.value` to move the fire. */
    uOrigin: ReturnType<typeof dynoVec3>;
    /** Extra shimmer when the fire is fed — mutate `.value` (0 = resting). */
    uFed: ReturnType<typeof dynoFloat>;
};

export function initHeat(): Heat {
    const uOrigin = dynoVec3(new THREE.Vector3().copy(LIGHT_ORIGIN));
    const uRadius = dynoFloat(RADIUS);
    const uStrength = dynoFloat(STRENGTH);
    const uScale = dynoFloat(SCALE);
    const uFed = dynoFloat(0);

    const modifier = dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
        if (!gsplat) throw new Error('heat modifier: no gsplat input');

        const node = dyno.dyno({
            inTypes: {
                gsplat: dyno.Gsplat,
                origin: 'vec3',
                radius: 'float',
                strength: 'float',
                scale: 'float',
                time: 'float',
                fed: 'float',
            },
            outTypes: { gsplat: dyno.Gsplat },
            inputs: {
                gsplat,
                origin: uOrigin,
                radius: uRadius,
                strength: uStrength,
                scale: uScale,
                time: SplatMesh.dynoTime, // auto-updated by the SparkRenderer each frame
                fed: uFed,
            },
            globals: () => [defineGsplat, NOISE_GLSL],
            statements: ({ inputs, outputs }) => {
                const g = outputs.gsplat;
                return unindentLines(`
                    ${g} = ${inputs.gsplat};
                    vec3 rel = ${inputs.gsplat}.center - ${inputs.origin};
                    float dist = length(rel);
                    float mask = 1.0 - smoothstep(${inputs.radius} * 0.15, ${inputs.radius}, dist);
                    mask *= mask; // bias the heat toward the core
                    if (mask > 0.0) {
                        // Scroll by a looping phase: each axis advances a whole
                        // number of tile-periods per loop, so it returns seamlessly.
                        float phase = fract(${inputs.time} / ${LOOP_SECONDS.toFixed(1)});
                        float P = ${NOISE_PERIOD.toFixed(1)};
                        vec3 p = ${inputs.gsplat}.center * ${inputs.scale};
                        float nx = heatNoise(p.yz + vec2(0.0, -phase * 2.0 * P));
                        float ny = heatNoise(p.xz * 1.1 + vec2(-phase * 1.0 * P, phase * 1.0 * P));
                        float nz = heatNoise(p.xy * 1.3 + vec2(phase * 1.0 * P, -phase * 2.0 * P));
                        vec3 off = (vec3(nx, ny, nz) - 0.5) * 2.0;
                        off.y = abs(off.y) * 1.5; // heat rises — bias the wobble upward
                        ${g}.center = ${inputs.gsplat}.center
                            + off * ${inputs.strength} * mask * (1.0 + ${inputs.fed} * 1.5);
                    }
                `);
            },
        });

        return { gsplat: node.outputs.gsplat };
    });

    return { modifier, uOrigin, uFed };
}

// Shimmer rides the sustained intensity and surges on each blast. The generous
// pulse kick (0.9) makes a stoke ripple the air distinctly from the glow.
export function updateHeat(heat: Heat, furnace: Furnace): void {
    heat.uFed.value = furnaceHeat(furnace, 0.9);
}
