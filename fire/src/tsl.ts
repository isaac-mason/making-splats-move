/**
 * What the fire's particle generators share: TSL helpers, the clock, and the
 * generator plumbing itself.
 *
 * The flame, smoke and embers ride the same curl field, so they churn together
 * instead of looking like unrelated effects stacked up. The helpers are TSL
 * functions with layouts, so each is emitted once per shader and called, not
 * inlined at every use.
 */

import { GpuSplats, SplatCollection, type SplatNode, type SplatObject, TSL, type TslNode } from 'spark-radix';

const { Fn, cos, cross, dot, float, fract, normalize, sin, uint, uniform, vec3, vec4 } = TSL;

/** Seconds since the start, shared by every generator and modifier. Set once a frame. */
export const time = uniform(0);

// Divergence-free curl noise. The curl of a SINE potential is analytic, so a few
// cosines give an exact field rather than six noise samples for finite
// differences. Divergence-free: particles swirl past each other instead of piling
// up or thinning out.
const K1 = vec3(1.7, 1.1, -1.3);
const K2 = vec3(-1.2, 1.9, 1.5);
const K3 = vec3(1.4, -1.6, 1.8);

const curlOctave = Fn(([p, phase]: TslNode[]) => {
    const c1 = cos(dot(K1, p).add(phase.x));
    const c2 = cos(dot(K2, p).add(phase.y));
    const c3 = cos(dot(K3, p).add(phase.z));
    return vec3(c3.mul(K3.y).sub(c2.mul(K2.z)), c1.mul(K1.z).sub(c3.mul(K3.x)), c2.mul(K2.x).sub(c1.mul(K1.y)));
}).setLayout({
    name: 'flameCurlOctave',
    type: 'vec3',
    inputs: [
        { name: 'p', type: 'vec3' },
        { name: 'phase', type: 'vec3' },
    ],
});

/**
 * Time EVOLVES the field rather than sliding it: each octave's phase turns at its
 * own rate, so small eddies form and break up while large ones hold. Roughly unit
 * magnitude, so a caller's turbulence is in world units.
 */
export const flameCurl = Fn(([p, t]: TslNode[]) =>
    curlOctave(p, vec3(1.13, -0.87, 1.51).mul(t))
        .add(curlOctave(p.mul(2.63).add(11.3), vec3(-2.9, 3.7, 3.1).mul(t)).mul(0.5))
        .mul(0.26),
).setLayout({
    name: 'flameCurl',
    type: 'vec3',
    inputs: [
        { name: 'p', type: 'vec3' },
        { name: 't', type: 'float' },
    ],
});

/**
 * Shortest-arc rotation taking +Y onto dir, as an xyzw quaternion. The epsilon
 * keeps a straight-down dir from normalising zero into NaN.
 */
export const flameAlignY = (dir: TslNode): TslNode => normalize(vec4(cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));

/** Four hashes in [0, 1) of a whole-number seed (as a float). */
export const flameHash = Fn(([i]: TslNode[]) => {
    const p = fract(vec3(i).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
    p.addAssign(dot(p, p.yzx.add(33.33)));
    const a = fract(p.xxy.add(p.yzz).mul(p.zyx));
    const w = fract(sin(i.mul(78.233)).mul(43758.5453));
    return vec4(a, w);
}).setLayout({ name: 'flameHash', type: 'vec4', inputs: [{ name: 'i', type: 'float' }] });

/** `index * scale + offset` as a float, for seeding flameHash. */
export function seed(index: TslNode, scale = 1, offset = 0): TslNode {
    return float(uint(index)).mul(scale).add(offset);
}

/** A colour or point as a TSL constant. */
export function v3([x, y, z]: readonly [number, number, number]): TslNode {
    return vec3(x, y, z);
}

/** The fields of a generated splat, set by a particle body. */
export type Particle = { center: TslNode; scales: TslNode; quaternion?: TslNode; rgb: TslNode; opacity: TslNode };

/**
 * A stateless particle system: `body` makes splat `index` from the index and
 * `time` alone. One object in the renderer's collection, at the world origin.
 */
export function particles(count: number, body: (index: TslNode) => Particle): SplatObject {
    return SplatCollection.object({
        count,
        generator: {
            generateSplat: (index: TslNode): SplatNode => {
                const { center, scales, quaternion = vec4(0, 0, 0, 1), rgb, opacity } = body(index);
                return GpuSplats.Splat(center, scales, quaternion, rgb, opacity, uint(index));
            },
        },
    });
}
