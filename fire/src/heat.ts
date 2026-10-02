/**
 * Heat shimmer: wobbles the captured scene's splats in a column of hot air over the
 * fire, hardest just above the coals.
 */

import { dyno as d, type GsplatModifier, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { type Fire, fireHeat } from './fire';
import { literals } from './glsl';
import { FIRE_ORIGIN } from './scene';

const HEAT = literals({
    origin: new THREE.Vector3(...FIRE_ORIGIN),
    baseRadius: 0.55,
    plumeHeight: 1.9,
    maxOffset: 0.009,
    rippleFrequency: 5.5,
    // Whole: the noise tiles at this period, which is what lets the scroll loop seamlessly.
    noisePeriod: 8,
    loopSeconds: 6,
});

const NOISE_GLSL = /* glsl */ `
    float heatHash(vec2 p) {
        p = fract(p * vec2(0.3183099, 0.3678794) + 0.1);
        p += dot(p, p + 27.13);
        return fract(p.x * p.y);
    }
    float heatNoise(vec2 x) {
        const float PERIOD = ${HEAT.noisePeriod};
        vec2 i = floor(x);
        vec2 f = fract(x);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = heatHash(mod(i, PERIOD));
        float b = heatHash(mod(i + vec2(1.0, 0.0), PERIOD));
        float c = heatHash(mod(i + vec2(0.0, 1.0), PERIOD));
        float d = heatHash(mod(i + vec2(1.0, 1.0), PERIOD));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
`;

export type Heat = { modifier: GsplatModifier; fed: ReturnType<typeof d.dynoFloat> };

export function initHeat(): Heat {
    const h = HEAT;
    const fed = d.dynoFloat(0);

    const modifier = d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
        const node = d.dyno({
            inTypes: { gsplat: d.Gsplat, time: 'float', fed: 'float' },
            outTypes: { gsplat: d.Gsplat },
            inputs: { gsplat, time: SplatMesh.dynoTime, fed },
            globals: () => [d.defineGsplat, NOISE_GLSL],
            statements: ({ inputs: i, outputs: o }) =>
                d.unindentLines(`
                    ${o.gsplat} = ${i.gsplat};
                    vec3 rel = ${i.gsplat}.center - ${h.origin};
                    float up = rel.y;

                    float width = ${h.baseRadius} * (0.5 + 0.6 * clamp(up / ${h.plumeHeight}, 0.0, 1.0));
                    float inColumn = (1.0 - smoothstep(width * 0.35, width, length(rel.xz)))
                                   * smoothstep(-0.32, -0.06, up)
                                   * (1.0 - smoothstep(${h.plumeHeight} * 0.45, ${h.plumeHeight}, up));
                    float overCoals = 0.5 + 1.4 * exp(-up * up * 18.0);
                    float mask = inColumn * inColumn * overCoals;

                    if (mask > 0.0) {
                        float scroll = ${h.noisePeriod} * fract(${i.time} / ${h.loopSeconds});
                        vec3 p = ${i.gsplat}.center * ${h.rippleFrequency};
                        vec3 offset = vec3(
                            heatNoise(p.yz + vec2(0.0, -2.0 * scroll)),
                            heatNoise(p.xz * 1.1 + vec2(-scroll, scroll)),
                            heatNoise(p.xy * 1.3 + vec2(scroll, -2.0 * scroll))
                        ) * 2.0 - 1.0;
                        offset.y = abs(offset.y) * 1.5;
                        ${o.gsplat}.center += offset * ${h.maxOffset} * mask * (1.0 + ${i.fed} * 1.5);
                    }
                `),
        });
        return { gsplat: node.outputs.gsplat };
    });

    return { modifier, fed };
}

export function updateHeat(heat: Heat, fire: Fire): void {
    heat.fed.value = fireHeat(fire, 0.9);
}
