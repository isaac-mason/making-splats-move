import { dyno, type GsplatModifier, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { type Fire, fireHeat } from './fire';
import { LIGHT_ORIGIN } from './lighting';

const { dynoBlock, dynoFloat, dynoVec3, defineGsplat, unindentLines } = dyno;

// Half-width of the column at its base, in world units. It widens with height.
const RADIUS = 0.55;

// How far up the disturbed air reaches.
const PLUME = 1.9;

// Max world-space displacement (metres). Small — shimmer is a subtle bend, and
// this is biased hard toward the coal bed (see COALS in the shader), where the
// temperature gradient is steepest and where you actually see air boiling.
const STRENGTH = 0.009;

// World-space frequency of the wobble. Higher = finer ripples. Sized for logs and
// stones rather than for the whole clearing: coarse ripples over a 0.5m log read as the log
// bending, fine ones read as air.
const SCALE = 5.5;

// The noise tiles every NOISE_PERIOD units, so scrolling it by whole periods loops
// seamlessly every LOOP_SECONDS and keeps coordinates out of float32's bad range.
const NOISE_PERIOD = 8;
const LOOP_SECONDS = 6;

// Tileable value noise: the lattice wraps at HEAT_PERIOD, and the hash avoids
// large-argument sin().
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
    const uPlume = dynoFloat(PLUME);
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
                plume: 'float',
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
                plume: uPlume,
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
                    float across = length(rel.xz);
                    float up = rel.y;

                    // The plume: a column standing on the coals, widening as it
                    // rises. Reaches a little BELOW the origin too, for the stones
                    // taking radiant heat off the fire.
                    float wide = ${inputs.radius} * (0.5 + 0.6 * clamp(up / ${inputs.plume}, 0.0, 1.0));
                    float radial = 1.0 - smoothstep(wide * 0.35, wide, across);
                    float column = smoothstep(-0.32, -0.06, up)
                                 * (1.0 - smoothstep(${inputs.plume} * 0.45, ${inputs.plume}, up));
                    float mask = radial * column;
                    mask *= mask; // bias the heat toward the core

                    // Hottest right at the coal bed, in a tight band. This is the
                    // one place the effect wants to be obvious rather than subtle:
                    // air visibly boils over embers, and the gradient that does it
                    // falls off within a few centimetres.
                    mask *= 0.5 + 1.4 * exp(-up * up * 18.0);
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
export function updateHeat(heat: Heat, fire: Fire): void {
    heat.uFed.value = fireHeat(fire, 0.9);
}
