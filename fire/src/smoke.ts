/**
 * Smoke: the layer above the flame, and what sells "burning" over "glowing". Each
 * puff lives ten seconds or more, rising, spreading and thinning to nothing.
 *
 * Heat is DELAYED: each puff reads the fire's heat as it was at its own birth, from
 * a short history, so a stoke travels up the column as a gout instead of the whole
 * column lurching at once.
 *
 * Colour is written straight, not premultiplied: Spark premultiplies in its own
 * shader, and doing it here too leaves the puffs a near-black filter.
 */

import { dyno as d } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { type Fire, fireHeat } from './fire';
import { float, literals, particles } from './glsl';
import { FLAME_ORIGIN } from './scene';

const COUNT = 4500;
const STEPS = 24;

const HISTORY_SECONDS = 20;
const HISTORY_SAMPLES = 128;
const HISTORY_STEP = HISTORY_SECONDS / HISTORY_SAMPLES;

const s = literals({
    origin: new THREE.Vector3(...FLAME_ORIGIN),
    baseRadius: 0.16,
    liftOff: 0.55,
    rate: 0.085,
    riseSpeed: 1.3,
    coolTime: 5.0,
    terminalRise: 0.1,
    spread: 0.13,
    turbulence: 0.25,
    curlScale: 0.7,
    curlScroll: 0.12,
    wind: new THREE.Vector3(0.22, 0, -0.1),
    gust: 0.55,
    startSize: 0.05,
    endSize: 0.5,
    opacity: 0.02,
    warm: new THREE.Color(0.16, 0.15, 0.17),
    cool: new THREE.Color(0.1, 0.11, 0.15),
});

const SMOKE_GLSL = /* glsl */ `
    float smokeHeatAt(sampler2D history, float secondsAgo) {
        float u = (secondsAgo / ${HISTORY_STEP.toFixed(6)} + 0.5) / ${float(HISTORY_SAMPLES)};
        return texture(history, vec2(clamp(u, 0.0, 1.0), 0.5)).r;
    }
`;

export type Smoke = {
    object: THREE.Object3D;
    history: Uint8Array;
    historyTex: THREE.DataTexture;
    sinceSample: number;
};

export function initSmoke(fire: Fire): Smoke {
    const history = new Uint8Array(HISTORY_SAMPLES).fill(Math.round(fireHeat(fire) * 255));
    const historyTex = new THREE.DataTexture(history, HISTORY_SAMPLES, 1, THREE.RedFormat, THREE.UnsignedByteType);
    historyTex.minFilter = THREE.LinearFilter;
    historyTex.magFilter = THREE.LinearFilter;
    historyTex.needsUpdate = true;

    const object = particles({
        count: COUNT,
        uniforms: { history: d.dynoSampler2D(historyTex) },
        globals: [SMOKE_GLSL],
        body: ({ index, time, history }, g) => /* glsl */ `
            vec4 rand = flameHash(${index} * 3 + 7);
            vec4 rand2 = flameHash(${index} * 3 + 8);
            float rate = ${s.rate} * (0.7 + rand.x * 0.6);
            float age = fract(rand.w * 5.37 + ${time} * rate);
            float elapsed = age / rate;
            float heatAtBirth = smokeHeatAt(${history}, elapsed);

            float bedAngle = rand.y * 6.2831853;
            float bedRadius = sqrt(rand.z) * ${s.baseRadius};
            float handoverHeight = ${s.liftOff} * (0.6 + 0.8 * rand2.x);
            vec3 pos = ${s.origin} + vec3(cos(bedAngle) * bedRadius, handoverHeight, sin(bedAngle) * bedRadius);

            float dt = elapsed / ${float(STEPS)};
            for (int step = 0; step < ${STEPS}; step++) {
                float secondsOld = (float(step) + 0.5) * dt;
                float heightAboveFire = clamp((pos.y - ${s.origin}.y) / 5.0, 0.0, 1.0);

                float rise = ${s.riseSpeed} * (0.5 + 0.9 * heatAtBirth) * exp(-secondsOld / ${s.coolTime}) + ${s.terminalRise};

                vec2 fromAxis = pos.xz - ${s.origin}.xz;
                vec2 outward = fromAxis / max(length(fromAxis), 1e-4);
                vec2 spread = outward * ${s.spread} * (rise + 0.4);

                vec3 fieldPos = pos * ${s.curlScale} - vec3(0.0, ${time} * ${s.curlScroll}, 0.0);
                vec3 curl = flameCurl(fieldPos, ${time} * 0.12) * ${s.turbulence} * (0.2 + 1.4 * heightAboveFire);

                float gustTravellingUp = 1.0 + ${s.gust} * (0.6 * sin(${time} * 0.21 + pos.y * 0.45) + 0.4 * sin(${time} * 0.37 + 1.7));
                vec3 breeze = ${s.wind} * (0.1 + 1.2 * heightAboveFire) * gustTravellingUp;

                pos += (vec3(spread.x, rise, spread.y) + curl + breeze) * dt;
            }

            float fade = smoothstep(0.0, 0.1, age) * pow(max(1.0 - age, 0.0), 2.2);

            ${g}.center = pos;
            ${g}.flags = GSPLAT_FLAG_ACTIVE;
            ${g}.scales = vec3(mix(${s.startSize}, ${s.endSize}, pow(age, 0.7)));
            ${g}.index = ${index};
            ${g}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
            ${g}.rgba = vec4(mix(${s.warm}, ${s.cool}, smoothstep(0.0, 0.4, age)),
                             ${s.opacity} * fade * (0.25 + 1.1 * heatAtBirth));
        `,
    });

    return { object, history, historyTex, sinceSample: 0 };
}

export function updateSmoke(smoke: Smoke, fire: Fire, dt: number): void {
    smoke.sinceSample += dt;
    while (smoke.sinceSample >= HISTORY_STEP) {
        smoke.sinceSample -= HISTORY_STEP;
        smoke.history.copyWithin(1, 0);
        smoke.history[0] = Math.round(fireHeat(fire) * 255);
        smoke.historyTex.needsUpdate = true;
    }
}
