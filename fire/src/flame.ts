/**
 * The flame: splats generated on the GPU each frame, nothing stored. Being splats,
 * it sorts with the capture, so the logs and stones in front of it hide it.
 *
 * Stateless, like the dust: every particle is a closed-form function of its index
 * and the time, with `age = fract(seed + time * rate)`. Colour and brightness follow
 * a TEMPERATURE carried along each particle's path, not its age — keyed to age, a
 * lick flung into cold air would glow as bright as one up the core.
 */

import { dyno as d } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { type Fire, fireHeat } from './fire';
import { float, literals, particles } from './glsl';
import { FLAME_ORIGIN } from './scene';

const COUNT = 62000;
const GLOW_COUNT = 6000;
const STEPS = 6;

const f = literals({
    origin: new THREE.Vector3(...FLAME_ORIGIN),
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
    hot: new THREE.Vector3(1.0, 0.98, 0.86),
    mid: new THREE.Vector3(1.0, 0.42, 0.06),
    cool: new THREE.Vector3(0.42, 0.03, 0.005),
});

export type Flame = { object: THREE.Object3D; heat: ReturnType<typeof d.dynoFloat> };

export function initFlame(): Flame {
    const heat = d.dynoFloat(0);
    const object = particles({
        count: COUNT + GLOW_COUNT,
        uniforms: { heat },
        body: ({ index, time, heat }, g) => /* glsl */ `
            vec4 rand = flameHash(${index});
            float rate = ${f.rate} * (0.7 + rand.x * 0.6);
            float age = fract(rand.w * 7.13 + ${time} * rate);
            float elapsed = age / rate;

            float bedAngle = rand.y * 6.2831853;
            float bedRadius = sqrt(rand.z) * ${f.baseRadius};
            vec3 pos = ${f.origin} + vec3(cos(bedAngle), 0.0, sin(bedAngle)) * bedRadius;

            float bedNoise = (sin(dot(pos.xz, vec2(19.0, 13.0)) + ${time} * 0.8)
                            + 0.7 * sin(dot(pos.xz, vec2(-11.0, 27.0)) + ${time} * 0.55 + 2.1)
                            + 0.5 * sin(dot(pos.xz, vec2(33.0, -21.0)) - ${time} * 1.1 + 4.3)) / 2.2;
            float patchAlight = smoothstep(-0.5, 0.5, bedNoise + 1.3 * (${heat} - 0.45));
            float footprint = 0.75 + 0.35 * sin(bedAngle * 3.0 + ${time} * 0.25) + 0.2 * sin(bedAngle * 5.0 - ${time} * 0.17 + 1.3);
            float edgeFalloff = 1.0 - 0.4 * min(bedRadius / (${f.baseRadius} * footprint), 1.0);
            float fuel = (1.0 - ${f.unevenness} * (1.0 - patchAlight)) * edgeFalloff;
            float temp = fuel * 0.35;

            vec3 vel = vec3(0.0);
            float dt = elapsed / ${float(STEPS)};
            for (int step = 0; step < ${STEPS}; step++) {
                float lifeFraction = (float(step) + 0.5) / ${float(STEPS)} * age;
                float stepTime = ${time} - elapsed + lifeFraction / rate;
                vec2 fromAxis = pos.xz - ${f.origin}.xz;
                float axisDist = length(fromAxis);

                vec3 fieldPos = pos * ${f.curlScale} - vec3(0.0, stepTime * ${f.curlScroll}, 0.0);
                float coolGasWanders = 1.35 - 0.45 * temp;
                vec3 curl = flameCurl(fieldPos, stepTime * ${f.curlEvolve})
                          * ${f.turbulence} * (0.56 + 0.9 * lifeFraction) * coolGasWanders;

                float stillBurning = 1.0 - smoothstep(0.0, ${f.burnTime}, lifeFraction);
                temp += ${f.burnRate} * fuel * stillBurning * dt;
                float edgeExposure = min(axisDist / ${f.baseRadius}, 1.6);
                float shear = length(curl) / ${f.turbulence};
                float airMixing = ${f.mixing} * (0.3 + 1.2 * edgeExposure + 0.8 * shear) * (0.3 + 1.6 * lifeFraction);
                temp = min(temp * exp(-airMixing * dt), 1.0);

                vec2 draft = -fromAxis / max(axisDist, 1e-4)
                           * ${f.inflow} * (1.0 - 0.7 * lifeFraction) * min(axisDist / ${f.baseRadius}, 1.5);
                float buoyancy = ${f.riseSpeed} * temp;
                vel = vec3(draft.x, buoyancy, draft.y) + curl;
                pos += vel * dt;
            }

            vec3 col = temp > 0.5 ? mix(${f.mid}, ${f.hot}, temp * 2.0 - 1.0) : mix(${f.cool}, ${f.mid}, temp * 2.0);
            float heatBoost = 0.55 + 0.6 * ${heat};

            ${g}.center = pos;
            ${g}.flags = GSPLAT_FLAG_ACTIVE;
            ${g}.index = ${index};
            if (${index} >= ${COUNT}) {
                float fade = smoothstep(0.0, 0.1, age) * (1.0 - smoothstep(0.55, 1.0, age));
                ${g}.scales = vec3(${f.glowSize} * (0.7 + rand.x * 0.6));
                ${g}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
                ${g}.rgba = vec4(col, pow(max(temp, 0.0), ${f.glowSharpness}) * ${f.glowOpacity} * heatBoost * fade);
            } else {
                float fade = smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.7, 1.0, age));
                float swell = pow(sin(age * 3.14159), 0.55 + rand.y * 1.1);
                float scale = ${f.size} * swell * (0.6 + rand.x * 0.7) * (0.7 + 0.5 * ${heat});
                ${g}.scales = vec3(scale, scale * ${f.stretch}, scale);
                ${g}.quaternion = flameAlignY(normalize(vel + vec3(0.0, 1e-4, 0.0)));
                ${g}.rgba = vec4(col, pow(max(temp, 0.0), ${f.glowFalloff}) * ${f.opacity} * heatBoost * fade);
            }
        `,
    });
    return { object, heat };
}

export function updateFlame(flame: Flame, fire: Fire): void {
    flame.heat.value = fireHeat(fire);
}
