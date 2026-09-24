import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { CURL_GLSL } from './curl';
import { FIREFLY_BACK_WIDTH, FIREFLY_EXTENT, FIREFLY_NEAR } from './scene';

/**
 * Fireflies — green glints drifting in the dark past the fire.
 *
 * Each firefly is two splats: a small bright core and a wide faint halo around it.
 * The halo is what makes it read as glowing rather than as a green dot; without it
 * they look like pixels at this distance.
 *
 * Nothing is simulated. A firefly hovers about a fixed home, wandering on a few
 * incommensurate sines, so its position is a pure function of time — no state, no
 * integration, and it never drifts out of the box. It spends most of its time dark
 * and flashes on its own slow period, which is what fireflies actually do; a field
 * of steadily lit ones reads as fairy lights.
 */

export type FireflyParams = {
    /** Number of fireflies (each is a core + a halo splat). */
    count: number;
    /** Front-centre of the box they live in, in world units. */
    near: THREE.Vector3;
    /** Size of that box: width (x), height (y), depth running towards -z. */
    extent: THREE.Vector3;
    /**
     * Width at the back of the box. It flares out from `extent.x` at the front,
     * because perspective squeezes the far end together — a straight box reads
     * as a narrow strip from the camera.
     */
    backWidth: number;
    /** How far a firefly wanders from its home: horizontal (x/z) and vertical (y). */
    wander: THREE.Vector2;
    /** Seconds between flashes, lower and upper bound (picked per firefly). */
    periodMin: number;
    periodMax: number;
    /** Fraction of each period the flash lasts. */
    flash: number;
    /** Glow left between flashes (0 = fully dark). */
    idle: number;
    /** Core and halo size, in world units. */
    coreSize: number;
    haloSize: number;
    /** Peak opacity of the core and of the halo. */
    coreOpacity: number;
    haloOpacity: number;
    color: THREE.Color;
};

export const DEFAULT_FIREFLIES: FireflyParams = {
    count: 320,
    near: new THREE.Vector3(FIREFLY_NEAR[0], FIREFLY_NEAR[1], FIREFLY_NEAR[2]),
    extent: new THREE.Vector3(FIREFLY_EXTENT[0], FIREFLY_EXTENT[1], FIREFLY_EXTENT[2]),
    backWidth: FIREFLY_BACK_WIDTH,
    wander: new THREE.Vector2(0.6, 0.25),
    periodMin: 4,
    periodMax: 9,
    flash: 0.5,
    idle: 0.04,
    coreSize: 0.02,
    haloSize: 0.12,
    coreOpacity: 1,
    haloOpacity: 0.3,
    color: new THREE.Color(0.65, 1.0, 0.25),
};

export type Fireflies = {
    /** The generator node — add to your scene. */
    object: SplatGenerator;
};

export function initFireflies(params: Partial<FireflyParams> = {}): Fireflies {
    const p: FireflyParams = { ...DEFAULT_FIREFLIES, ...params };

    const uNear = d.dynoVec3(p.near.clone());
    const uExtent = d.dynoVec3(p.extent.clone());
    const uBackWidth = d.dynoFloat(p.backWidth);
    const uWander = d.dynoVec2(p.wander.clone());
    const uPeriodMin = d.dynoFloat(p.periodMin);
    const uPeriodMax = d.dynoFloat(p.periodMax);
    const uFlash = d.dynoFloat(p.flash);
    const uIdle = d.dynoFloat(p.idle);
    const uCoreSize = d.dynoFloat(p.coreSize);
    const uHaloSize = d.dynoFloat(p.haloSize);
    const uCoreOpacity = d.dynoFloat(p.coreOpacity);
    const uHaloOpacity = d.dynoFloat(p.haloOpacity);
    const uColor = d.dynoVec3(new THREE.Vector3(p.color.r, p.color.g, p.color.b));
    const uTime = d.dynoFloat(0);

    const object = new SplatGenerator({
        numSplats: p.count * 2,
        generator: d.dynoBlock(
            { index: 'int' },
            { gsplat: d.Gsplat },
            ({ index }) => {
                if (!index) throw new Error('firefly generator: no index input');

                const node = d.dyno({
                    inTypes: {
                        index: 'int',
                        near: 'vec3',
                        extent: 'vec3',
                        backWidth: 'float',
                        wander: 'vec2',
                        periodMin: 'float',
                        periodMax: 'float',
                        flash: 'float',
                        idle: 'float',
                        coreSize: 'float',
                        haloSize: 'float',
                        coreOpacity: 'float',
                        haloOpacity: 'float',
                        color: 'vec3',
                        time: 'float',
                    },
                    outTypes: { gsplat: d.Gsplat },
                    inputs: {
                        index,
                        near: uNear,
                        extent: uExtent,
                        backWidth: uBackWidth,
                        wander: uWander,
                        periodMin: uPeriodMin,
                        periodMax: uPeriodMax,
                        flash: uFlash,
                        idle: uIdle,
                        coreSize: uCoreSize,
                        haloSize: uHaloSize,
                        coreOpacity: uCoreOpacity,
                        haloOpacity: uHaloOpacity,
                        color: uColor,
                        time: uTime,
                    },
                    globals: () => [d.defineGsplat, CURL_GLSL],
                    statements: ({ inputs, outputs }) => {
                        const g = outputs.gsplat;
                        const i = inputs;
                        return d.unindentLines(`
                            // Splats come in pairs: even = core, odd = halo, both
                            // keyed to the same firefly so they move and flash as one.
                            int fly = ${i.index} / 2;
                            bool halo = (${i.index} - fly * 2) == 1;
                            vec4 rand = flameHash(fly * 7 + 313);
                            vec4 rand2 = flameHash(fly * 11 + 719);

                            // Home: anywhere in the wedge, which starts at 'near' and
                            // runs back into the trees along -z, widening as it goes.
                            // sqrt biases depth towards the back, where the wedge is
                            // wider, so they spread evenly rather than bunching up front.
                            float depth = sqrt(rand.z);
                            float width = mix(${i.extent}.x, ${i.backWidth}, depth);
                            vec3 home = ${i.near} + vec3(
                                (rand.x - 0.5) * width,
                                (rand.y - 0.5) * ${i.extent}.y,
                                -depth * ${i.extent}.z
                            );

                            // Lazy wander: sines at unrelated rates never line up, so
                            // the path doesn't visibly repeat.
                            float t = ${i.time};
                            vec3 ph = rand2.xyz * 6.2831853;
                            vec3 wander = vec3(
                                sin(t * 0.31 + ph.x) + 0.5 * sin(t * 0.83 + ph.y),
                                sin(t * 0.47 + ph.z) + 0.4 * sin(t * 1.21 + ph.x),
                                sin(t * 0.27 + ph.y) + 0.5 * sin(t * 0.71 + ph.z)
                            ) / 1.5;
                            vec3 pos = home + wander * vec3(${i.wander}.x, ${i.wander}.y, ${i.wander}.x);

                            // Flash: a soft rise and a longer fade once per period,
                            // dark the rest of the time.
                            float period = mix(${i.periodMin}, ${i.periodMax}, rand.w);
                            float phase = fract(t / period + rand2.w);
                            float f = max(${i.flash}, 1e-3);
                            float glow = smoothstep(0.0, 0.35 * f, phase) * (1.0 - smoothstep(0.35 * f, f, phase));
                            glow = max(glow, ${i.idle});

                            float size = halo ? ${i.haloSize} : ${i.coreSize};
                            float alpha = (halo ? ${i.haloOpacity} : ${i.coreOpacity}) * glow;
                            // The core burns whiter than the halo around it.
                            vec3 col = halo ? ${i.color} : mix(${i.color}, vec3(1.0), 0.35);

                            ${g}.center = pos;
                            ${g}.flags = GSPLAT_FLAG_ACTIVE;
                            ${g}.scales = vec3(size * (0.8 + rand2.x * 0.4));
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

    return { object };
}
