/**
 * What the fire's particle generators share: GLSL helpers, a way to bake their
 * settings into the shader as literals, and the generator plumbing itself.
 *
 * The flame, smoke and embers ride the same curl field, so they churn together
 * instead of looking like unrelated effects stacked up. Spark de-duplicates
 * globals by exact string, so including this in every generator costs nothing.
 */

import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
import type * as THREE from 'three';

export const PARTICLE_GLSL = /* glsl */ `
    // Divergence-free curl noise. The curl of a SINE potential is analytic, so a
    // few cosines give an exact field rather than six noise samples for finite
    // differences. Divergence-free: particles swirl past each other instead of
    // piling up or thinning out.
    vec3 flameCurlOctave(vec3 p, vec3 phase) {
        vec3 k1 = vec3( 1.7,  1.1, -1.3);
        vec3 k2 = vec3(-1.2,  1.9,  1.5);
        vec3 k3 = vec3( 1.4, -1.6,  1.8);
        float c1 = cos(dot(k1, p) + phase.x);
        float c2 = cos(dot(k2, p) + phase.y);
        float c3 = cos(dot(k3, p) + phase.z);
        return vec3(
            k3.y * c3 - k2.z * c2,
            k1.z * c1 - k3.x * c3,
            k2.x * c2 - k1.y * c1
        );
    }

    // Time EVOLVES the field rather than sliding it: each octave's phase turns at
    // its own rate, so small eddies form and break up while large ones hold.
    // Roughly unit magnitude, so a caller's turbulence is in world units.
    vec3 flameCurl(vec3 p, float t) {
        return (flameCurlOctave(p, vec3(1.13, -0.87, 1.51) * t)
              + 0.5 * flameCurlOctave(p * 2.63 + 11.3, vec3(-2.9, 3.7, 3.1) * t)) * 0.26;
    }

    // Shortest-arc rotation taking +Y onto dir, as an xyzw quaternion.
    vec4 flameAlignY(vec3 dir) {
        return normalize(vec4(cross(vec3(0.0, 1.0, 0.0), dir), 1.0 + dir.y));
    }

    vec4 flameHash(int i) {
        vec3 p = fract(vec3(float(i)) * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yzx + 33.33);
        vec3 a = fract((p.xxy + p.yzz) * p.zyx);
        float w = fract(sin(float(i) * 78.233) * 43758.5453);
        return vec4(a, w);
    }
`;

type Literal = number | THREE.Vector2 | THREE.Vector3 | THREE.Color;

/** A number as a GLSL float literal. */
export function float(n: number): string {
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * A generator's settings as GLSL literals: numbers become floats, vectors and
 * colours become vec2/vec3. They're fixed for the page, so there's no reason to
 * route each one through a uniform.
 */
export function literals<T extends Record<string, Literal>>(settings: T): Record<keyof T, string> {
    const out = {} as Record<keyof T, string>;
    for (const key in settings) {
        const v: Literal = settings[key];
        if (typeof v === 'number') out[key] = float(v);
        else if ('r' in v) out[key] = `vec3(${float(v.r)}, ${float(v.g)}, ${float(v.b)})`;
        else if ('z' in v) out[key] = `vec3(${float(v.x)}, ${float(v.y)}, ${float(v.z)})`;
        else out[key] = `vec2(${float(v.x)}, ${float(v.y)})`;
    }
    return out;
}

// biome-ignore lint/suspicious/noExplicitAny: any uniform type (float, sampler2D, …)
type Uniform = d.DynoUniform<any, string, any>;

/**
 * A stateless particle generator: `body` writes splat `g` from `index` and `time`,
 * plus any `uniforms` the caller still changes per frame. `time` is kept current
 * here, and the generator is left out of raycasts so it can't intercept the debug
 * panel's measuring clicks.
 */
export function particles<U extends Record<string, Uniform>>({
    count,
    uniforms,
    globals = [],
    body,
}: {
    count: number;
    uniforms: U;
    globals?: string[];
    body: (inputs: Record<keyof U | 'index' | 'time', string>, g: string) => string;
}): SplatGenerator {
    const time = d.dynoFloat(0);
    const all: Record<string, Uniform> = { ...uniforms, time };
    const inTypes = { index: 'int', ...Object.fromEntries(Object.entries(all).map(([k, u]) => [k, u.type])) } as const;

    const object = new SplatGenerator({
        numSplats: count,
        generator: d.dynoBlock(
            { index: 'int' },
            { gsplat: d.Gsplat },
            ({ index }) => {
                const node = d.dyno({
                    inTypes,
                    outTypes: { gsplat: d.Gsplat },
                    inputs: { index, ...all },
                    globals: () => [d.defineGsplat, PARTICLE_GLSL, ...globals],
                    statements: ({ inputs, outputs }) =>
                        d.unindentLines(body(inputs as Record<keyof U | 'index' | 'time', string>, outputs.gsplat as string)),
                });
                return { gsplat: node.outputs.gsplat };
            },
            { globals: () => [d.defineGsplat] },
        ),
        update: ({ time: now }) => {
            time.value = now;
            object.updateVersion();
        },
    });
    object.raycast = () => {};
    return object;
}
