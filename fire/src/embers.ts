import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { CURL_GLSL } from './curl';
import { type Fire, fireHeat } from './fire';
import { SPARK_ORIGIN } from './scene';

/**
 * Embers — the sparks that lift off the fire.
 *
 * Splats rather than THREE.Points: Spark's splats don't write depth, so Points can
 * only be ordered by render order, and an ember down inside the fire draws in
 * FRONT of the logs. As splats they sort with the scene and the flame. They ride
 * the same curl field as the flame and smoke (src/curl.ts), so all three churn
 * together.
 *
 * No burst API: brightness and reach follow the shared fire signal, which already
 * spikes on a stoke.
 */

export type EmberParams = {
    /** Number of embers alive at once. */
    count: number;
    /** Radius of the patch they lift off from, in world units. */
    baseRadius: number;
    /** Lifetimes per second. */
    rate: number;
    /** Upward velocity, in world units per second. */
    riseSpeed: number;
    /**
     * Seconds over which an ember's buoyancy bleeds away as it cools — so it shoots
     * up and then COASTS, drifting out over the clearing on the wind instead of
     * leaving the top of the frame.
     */
    coolTime: number;
    /** Breeze at height, in world units per second. Sheared, and matching the smoke's. */
    wind: THREE.Vector3;
    /** How hard the curl field throws them about. Embers are light — they get pushed further than flame. */
    turbulence: number;
    curlScale: number;
    /** Ember size, in world units. */
    size: number;
    /** Peak opacity. */
    opacity: number;
    /** Colour fresh off the fire, and as it dies. */
    hot: THREE.Color;
    cool: THREE.Color;
};

export const DEFAULT_EMBERS: EmberParams = {
    count: 1400,
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
};

// Euler steps per ember: enough to resolve a decaying rise plus a sheared wind.
const EMBER_STEPS = 6;
const EMBER_STEPS_GLSL = /* glsl */ `const int EMBER_STEPS = ${EMBER_STEPS};`;

export type Embers = {
    /** The generator node — add to your scene. */
    object: SplatGenerator;
    /** Push this frame's fire heat in (0 = embers, 1 = roaring). */
    setHeat(heat: number): void;
};

export function initEmbers(params: Partial<EmberParams> = {}): Embers {
    const p: EmberParams = { ...DEFAULT_EMBERS, ...params };

    const uOrigin = d.dynoVec3(new THREE.Vector3(SPARK_ORIGIN[0], SPARK_ORIGIN[1], SPARK_ORIGIN[2]));
    const uBaseRadius = d.dynoFloat(p.baseRadius);
    const uRate = d.dynoFloat(p.rate);
    const uRiseSpeed = d.dynoFloat(p.riseSpeed);
    const uCoolTime = d.dynoFloat(p.coolTime);
    const uWind = d.dynoVec3(p.wind.clone());
    const uTurbulence = d.dynoFloat(p.turbulence);
    const uCurlScale = d.dynoFloat(p.curlScale);
    const uSize = d.dynoFloat(p.size);
    const uOpacity = d.dynoFloat(p.opacity);
    const uHot = d.dynoVec3(new THREE.Vector3(p.hot.r, p.hot.g, p.hot.b));
    const uCool = d.dynoVec3(new THREE.Vector3(p.cool.r, p.cool.g, p.cool.b));
    const uHeat = d.dynoFloat(0);
    const uTime = d.dynoFloat(0);

    const object = new SplatGenerator({
        numSplats: p.count,
        generator: d.dynoBlock(
            { index: 'int' },
            { gsplat: d.Gsplat },
            ({ index }) => {
                if (!index) throw new Error('ember generator: no index input');

                const node = d.dyno({
                    inTypes: {
                        index: 'int',
                        origin: 'vec3',
                        baseRadius: 'float',
                        rate: 'float',
                        riseSpeed: 'float',
                        coolTime: 'float',
                        wind: 'vec3',
                        turbulence: 'float',
                        curlScale: 'float',
                        size: 'float',
                        opacity: 'float',
                        hot: 'vec3',
                        cool: 'vec3',
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
                        coolTime: uCoolTime,
                        wind: uWind,
                        turbulence: uTurbulence,
                        curlScale: uCurlScale,
                        size: uSize,
                        opacity: uOpacity,
                        hot: uHot,
                        cool: uCool,
                        heat: uHeat,
                        time: uTime,
                    },
                    globals: () => [d.defineGsplat, CURL_GLSL, EMBER_STEPS_GLSL],
                    statements: ({ inputs, outputs }) => {
                        const g = outputs.gsplat;
                        const i = inputs;
                        return d.unindentLines(`
                            vec4 rand = flameHash(${i.index} * 5 + 101);
                            float seed = rand.w;

                            float rate = ${i.rate} * (0.6 + rand.x * 0.9);
                            float age = fract(seed * 3.71 + ${i.time} * rate);
                            float elapsed = age / rate;

                            float ang = rand.y * 6.2831853;
                            float radius = sqrt(rand.z) * ${i.baseRadius};
                            vec3 pos = ${i.origin} + vec3(cos(ang) * radius, 0.0, sin(ang) * radius);

                            // Advected like the flame, but an ember is light and
                            // keeps its heat, so it rides further on the same eddies
                            // and slows as it cools rather than accelerating.
                            float dt = elapsed / float(EMBER_STEPS);
                            for (int k = 0; k < EMBER_STEPS; k++) {
                                // A fraction of the FULL life — see the note in
                                // src/flame.ts.
                                float through = ((float(k) + 0.5) / float(EMBER_STEPS)) * age;
                                float secs = through / rate;
                                float tStep = ${i.time} - elapsed + secs;

                                // Shoot up, then coast — see \`coolTime\`.
                                float buoy = ${i.riseSpeed} * (0.5 + 0.8 * ${i.heat})
                                           * exp(-secs / max(${i.coolTime}, 1e-3));

                                vec3 field = pos * ${i.curlScale} - vec3(0.0, tStep * 0.9, 0.0);
                                vec3 curl = flameCurl(field, tStep * 1.2) * ${i.turbulence} * (0.3 + 1.2 * through);

                                // Sheared breeze, keyed to HEIGHT rather than age so
                                // embers side by side drift together.
                                float high = clamp((pos.y - ${i.origin}.y) / 2.5, 0.0, 1.0);
                                vec3 breeze = ${i.wind} * (0.15 + 1.6 * high);

                                pos += (vec3(0.0, buoy, 0.0) + curl + breeze) * dt;
                            }

                            // Embers wink as they tumble. The long tail is so they
                            // go out over the grass, not all at one height.
                            float wink = 0.55 + 0.45 * sin(${i.time} * 9.0 + seed * 40.0);
                            float alpha = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.35, 1.0, age));
                            alpha *= ${i.opacity} * wink * (0.25 + 0.9 * ${i.heat});

                            vec3 col = mix(${i.hot}, ${i.cool}, smoothstep(0.0, 0.7, age));
                            float scale = ${i.size} * (0.6 + rand.x * 0.8) * (1.0 - 0.35 * age);

                            ${g}.center = pos;
                            ${g}.flags = GSPLAT_FLAG_ACTIVE;
                            ${g}.scales = vec3(scale);
                            ${g}.index = ${i.index};
                            ${g}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
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
            object.updateVersion();
        },
    });

    object.raycast = () => {};

    return {
        object,
        setHeat(heat) {
            uHeat.value = THREE.MathUtils.clamp(heat, 0, 1);
        },
    };
}

/** Convenience: drive the embers straight from the shared fire signal. */
export function updateEmbers(embers: Embers, fire: Fire): void {
    embers.setHeat(fireHeat(fire));
}
