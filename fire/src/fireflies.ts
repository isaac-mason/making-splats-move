/**
 * Fireflies: green glints drifting in the dark past the fire. Each is a bright core
 * and a wide faint halo; without the halo they read as pixels at this distance.
 *
 * Nothing is simulated: each hovers about a home in a wedge that widens towards the
 * back, so perspective doesn't squeeze it into a strip. They're dark most of the time
 * and flash on their own slow periods; steadily lit ones would read as fairy lights.
 */

import * as THREE from 'three';
import { literals, particles } from './glsl';
import { FIREFLY_BACK_WIDTH, FIREFLY_EXTENT, FIREFLY_NEAR } from './scene';

const COUNT = 320;

const f = literals({
    near: new THREE.Vector3(...FIREFLY_NEAR),
    extent: new THREE.Vector3(...FIREFLY_EXTENT),
    backWidth: FIREFLY_BACK_WIDTH,
    wander: new THREE.Vector2(0.6, 0.25),
    periodMin: 4,
    periodMax: 9,
    flashFraction: 0.5,
    idleGlow: 0.04,
    coreSize: 0.02,
    haloSize: 0.12,
    coreOpacity: 1,
    haloOpacity: 0.3,
    color: new THREE.Color(0.65, 1.0, 0.25),
});

export function initFireflies(): { object: THREE.Object3D } {
    const object = particles({
        count: COUNT * 2,
        uniforms: {},
        body: ({ index, time }, g) => /* glsl */ `
            int fly = ${index} / 2;
            bool isHalo = ${index} % 2 == 1;
            vec4 rand = flameHash(fly * 7 + 313);
            vec4 rand2 = flameHash(fly * 11 + 719);

            float depthEvenlySpread = sqrt(rand.z);
            float wedgeWidth = mix(${f.extent}.x, ${f.backWidth}, depthEvenlySpread);
            vec3 home = ${f.near} + vec3(
                (rand.x - 0.5) * wedgeWidth,
                (rand.y - 0.5) * ${f.extent}.y,
                -depthEvenlySpread * ${f.extent}.z
            );

            vec3 phases = rand2.xyz * 6.2831853;
            vec3 hover = vec3(
                sin(${time} * 0.31 + phases.x) + 0.5 * sin(${time} * 0.83 + phases.y),
                sin(${time} * 0.47 + phases.z) + 0.4 * sin(${time} * 1.21 + phases.x),
                sin(${time} * 0.27 + phases.y) + 0.5 * sin(${time} * 0.71 + phases.z)
            ) / 1.5;
            vec3 pos = home + hover * ${f.wander}.xyx;

            float period = mix(${f.periodMin}, ${f.periodMax}, rand.w);
            float flashPhase = fract(${time} / period + rand2.w);
            float flashPeak = 0.35 * ${f.flashFraction};
            float flash = smoothstep(0.0, flashPeak, flashPhase) * (1.0 - smoothstep(flashPeak, ${f.flashFraction}, flashPhase));
            float glow = max(flash, ${f.idleGlow});

            float size = isHalo ? ${f.haloSize} : ${f.coreSize};
            float opacity = isHalo ? ${f.haloOpacity} : ${f.coreOpacity};
            vec3 col = isHalo ? ${f.color} : mix(${f.color}, vec3(1.0), 0.35);

            ${g}.center = pos;
            ${g}.flags = GSPLAT_FLAG_ACTIVE;
            ${g}.scales = vec3(size * (0.8 + rand2.x * 0.4));
            ${g}.index = ${index};
            ${g}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
            ${g}.rgba = vec4(col, opacity * glow);
        `,
    });
    return { object };
}
