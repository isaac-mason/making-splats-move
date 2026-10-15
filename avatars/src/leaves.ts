/**
 * Leaves falling from the trees. Stateless, like the dust example's motes: each
 * leaf's life is a function of its index and the time, with no particle buffer.
 *
 * A leaf's age sweeps 0..1 and wraps. Over it, the leaf drops from its tree's crown,
 * rocking side to side and drifting downwind (the trees' wind, tree-sway.ts),
 * tumbling as it goes — then lands flat, lies a moment, and fades.
 */

import { type AnySplatObject, GpuSplatMath, GpuSplats, SplatCollection, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { GROUND_Y, TREES } from './scene';
import { WIND_DIRECTION } from './tree-sway';

/** Leaves alive at once, across both trees. */
const COUNT = 140;
/** Seconds from leaving the branch to fading on the grass. */
const LIFE = [10, 16];
/** Fraction of the life spent falling; the rest is lying on the grass. */
const FALL = 0.82;
/** Metres a leaf drifts downwind over its fall. */
const DRIFT = 4.5;
/** Metres a leaf rocks side to side. */
const ROCK = 0.45;
/** Half-size in metres. Cartoon-big: a real leaf is a speck from across the courtyard. */
const SIZE: [number, number, number] = [0.065, 0.043, 0.005];

// Mostly the canopy's greens, the odd one turning: to be noticed, not looked at.
const COLORS = [
    new THREE.Color('#5f9a2f'),
    new THREE.Color('#6f9e3a'),
    new THREE.Color('#4c7f26'),
    new THREE.Color('#58872e'),
    new THREE.Color('#b59a45'),
];

const {
    Fn,
    abs,
    cos,
    dot,
    float,
    floor,
    fract,
    min,
    mix,
    mod,
    normalize,
    select,
    sin,
    smoothstep,
    sqrt,
    step,
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

const windAngle = THREE.MathUtils.degToRad(WIND_DIRECTION);

/** Four hashes in [0, 1) of a whole-number seed (as a float). */
const leafHash = Fn(([i]: TslNode[]) => {
    const p = fract(vec3(i).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
    p.addAssign(dot(p, p.yzx.add(33.33)));
    const a = fract(p.xxy.add(p.yzz).mul(p.zyx));
    const w = fract(sin(i.mul(91.345)).mul(47453.5453));
    return vec4(a, w);
}).setLayout({ name: 'leafHash', type: 'vec4', inputs: [{ name: 'i', type: 'float' }] });

const quatAxisAngle = (axis: TslNode, angle: TslNode) => vec4(normalize(axis).mul(sin(angle.mul(0.5))), cos(angle.mul(0.5)));

/** One of a list of constants by index, as a select chain. */
function pick(values: TslNode[], index: TslNode): TslNode {
    let out = values[values.length - 1];
    for (let k = values.length - 2; k >= 0; k--) out = select(index.equal(float(k)), values[k], out);
    return out;
}

export type Leaves = { object: AnySplatObject; time: TslNode };

export function initLeaves(): Leaves {
    const time = uniform(0);
    const trees = TREES.map((t) => vec4(t.center[0], t.center[1], t.center[2], t.radius));
    const colors = COLORS.map((c) => vec3(c.r, c.g, c.b));
    const wind = vec2(Math.cos(windAngle), Math.sin(windAngle));

    const object = SplatCollection.object({
        count: COUNT,
        generator: {
            generateSplat: (index: TslNode) => {
                const i = float(uint(index)).toVar();
                const r = leafHash(i).toVar();
                const r2 = leafHash(i.add(7919)).toVar();
                const life = mix(LIFE[0], LIFE[1], r2.x);
                const age = fract(r.w.add(time.div(life))).toVar();
                // Which life this is, so a leaf leaves from somewhere new each time.
                const cycle = floor(r.w.add(time.div(life)));
                const s = leafHash(i.mul(31).add(mod(cycle, 997).mul(131))).toVar();

                const crown = pick(trees, mod(i, TREES.length)).toVar();

                // Somewhere in the lower two thirds of the crown.
                const ang = s.x.mul(Math.PI * 2);
                const rad = sqrt(s.y).mul(crown.w).mul(0.75);
                const start = crown.xyz
                    .add(vec3(cos(ang).mul(rad), s.z.sub(0.6).mul(crown.w).mul(0.7), sin(ang).mul(rad)))
                    .toVar();
                const ground = GROUND_Y + 0.01;

                // Fall, then lie still. Drift and rocking stop on landing.
                const fall = min(age.div(FALL), 1).toVar();
                const across = vec2(wind.y.negate(), wind.x);
                const swing = sin(time.mul(r2.y.add(1.8)).add(r.w.mul(40))).toVar();
                const airborne = step(fall, 0.9999).toVar();
                const pos = vec3(start.x, mix(start.y, ground, fall), start.z).toVar();
                pos.xz.addAssign(wind.mul(fall.mul(r2.z.mul(0.8).add(0.6)).mul(DRIFT)));
                // A little lift at each end of the swing.
                pos.xz.addAssign(across.mul(swing.mul(airborne).mul(r2.w.add(0.5)).mul(ROCK)));
                pos.y.addAssign(abs(swing).mul(0.08).mul(airborne));

                // Tumbling on the way down; lying flat once landed.
                const axis = normalize(r2.yzw.sub(0.5).add(vec3(0, 0, 0.01)));
                const tumble = quatAxisAngle(axis, time.mul(r.x.mul(2).add(2)).add(r.y.mul(20)));
                const flat = GpuSplatMath.quatMul(
                    quatAxisAngle(vec3(0, 1, 0), r.y.mul(Math.PI * 2)),
                    quatAxisAngle(vec3(1, 0, 0), float(-1.5708)),
                );
                const quat = select(airborne.greaterThan(0.5), tumble, flat);

                const col = pick(colors, floor(s.w.mul(COLORS.length)));

                // In at the branch, out on the grass.
                const alpha = smoothstep(0, 0.04, age)
                    .mul(smoothstep(0.9, 1, age).oneMinus())
                    .mul(0.85);
                const size = r.z.mul(0.4).add(0.8);

                return GpuSplats.Splat(pos, vec3(...SIZE).mul(size), quat, col, alpha, uint(index));
            },
        },
    });

    return { object, time };
}

export function tickLeaves(leaves: Leaves, seconds: number): void {
    leaves.time.value = seconds;
}
