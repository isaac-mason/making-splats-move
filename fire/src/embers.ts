/**
 * Embers: the sparks that lift off the fire. Splats rather than THREE.Points so they
 * sort with the scene: as Points, an ember down among the logs would draw in front of
 * them. Walked through the same curl field as the flame, but light and slow to cool,
 * so they ride further on it and coast out over the clearing.
 */

import { dyno as d } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { type Fire, fireHeat } from './fire';
import { float, literals, particles } from './glsl';
import { SPARK_ORIGIN } from './scene';

const COUNT = 1400;
const STEPS = 6;

const e = literals({
    origin: new THREE.Vector3(...SPARK_ORIGIN),
    baseRadius: 0.22,
    rate: 0.28,
    riseSpeed: 1.5,
    coolTime: 1.6,
    wind: new THREE.Vector3(0.3, 0, -0.14),
    turbulence: 0.7,
    curlScale: 2.2,
    size: 0.008,
    opacity: 0.85,
    hot: new THREE.Color(1.0, 0.85, 0.5),
    cool: new THREE.Color(0.9, 0.22, 0.04),
});

export type Embers = { object: THREE.Object3D; heat: ReturnType<typeof d.dynoFloat> };

export function initEmbers(): Embers {
    const heat = d.dynoFloat(0);
    const object = particles({
        count: COUNT,
        uniforms: { heat },
        body: ({ index, time, heat }, g) => /* glsl */ `
            vec4 rand = flameHash(${index} * 5 + 101);
            float rate = ${e.rate} * (0.6 + rand.x * 0.9);
            float age = fract(rand.w * 3.71 + ${time} * rate);
            float elapsed = age / rate;

            float bedAngle = rand.y * 6.2831853;
            float bedRadius = sqrt(rand.z) * ${e.baseRadius};
            vec3 pos = ${e.origin} + vec3(cos(bedAngle), 0.0, sin(bedAngle)) * bedRadius;

            float dt = elapsed / ${float(STEPS)};
            for (int step = 0; step < ${STEPS}; step++) {
                float lifeFraction = (float(step) + 0.5) / ${float(STEPS)} * age;
                float secondsOld = lifeFraction / rate;
                float stepTime = ${time} - elapsed + secondsOld;

                float buoyancy = ${e.riseSpeed} * (0.5 + 0.8 * ${heat}) * exp(-secondsOld / ${e.coolTime});
                vec3 fieldPos = pos * ${e.curlScale} - vec3(0.0, stepTime * 0.9, 0.0);
                vec3 curl = flameCurl(fieldPos, stepTime * 1.2) * ${e.turbulence} * (0.3 + 1.2 * lifeFraction);
                float heightAboveFire = clamp((pos.y - ${e.origin}.y) / 2.5, 0.0, 1.0);
                vec3 breeze = ${e.wind} * (0.15 + 1.6 * heightAboveFire);

                pos += (vec3(0.0, buoyancy, 0.0) + curl + breeze) * dt;
            }

            float wink = 0.55 + 0.45 * sin(${time} * 9.0 + rand.w * 40.0);
            float fade = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.35, 1.0, age));
            float scale = ${e.size} * (0.6 + rand.x * 0.8) * (1.0 - 0.35 * age);

            ${g}.center = pos;
            ${g}.flags = GSPLAT_FLAG_ACTIVE;
            ${g}.scales = vec3(scale);
            ${g}.index = ${index};
            ${g}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
            ${g}.rgba = vec4(mix(${e.hot}, ${e.cool}, smoothstep(0.0, 0.7, age)),
                             ${e.opacity} * wink * fade * (0.25 + 0.9 * ${heat}));
        `,
    });
    return { object, heat };
}

export function updateEmbers(embers: Embers, fire: Fire): void {
    embers.heat.value = fireHeat(fire);
}
