/**
 * Leaves falling from the trees. Stateless, like the dust example's motes: each
 * leaf's life is a function of its index and the time, with no particle buffer.
 *
 * A leaf's age sweeps 0..1 and wraps. Over it, the leaf drops from its tree's crown,
 * rocking side to side and drifting downwind (the trees' wind, tree-sway.ts),
 * tumbling as it goes — then lands flat, lies a moment, and fades.
 */

import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
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

/** A number as a GLSL float literal. */
const f = (n: number) => n.toFixed(4);
const windAngle = THREE.MathUtils.degToRad(WIND_DIRECTION);

const LEAVES_GLSL = /* glsl */ `
const vec4 LEAF_TREES[${TREES.length}] = vec4[](${TREES.map((t) => `vec4(${[...t.center, t.radius].map(f).join(', ')})`).join(', ')});
const vec3 LEAF_COLORS[${COLORS.length}] = vec3[](${COLORS.map((c) => `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`).join(', ')});
const vec2 LEAF_WIND = vec2(${f(Math.cos(windAngle))}, ${f(Math.sin(windAngle))});

vec4 leafHash(int i) {
    vec3 p = fract(vec3(float(i)) * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    vec3 a = fract((p.xxy + p.yzz) * p.zyx);
    float w = fract(sin(float(i) * 91.345) * 47453.5453);
    return vec4(a, w);
}
vec4 quatMul(vec4 a, vec4 b) {
    return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
vec4 quatAxisAngle(vec3 axis, float angle) {
    return vec4(normalize(axis) * sin(angle * 0.5), cos(angle * 0.5));
}
`;

export type Leaves = { object: SplatGenerator };

export function initLeaves(): Leaves {
    const uTime = d.dynoFloat(0);

    const object = new SplatGenerator({
        numSplats: COUNT,
        generator: d.dynoBlock(
            { index: 'int' },
            { gsplat: d.Gsplat },
            ({ index }) => {
                if (!index) throw new Error('leaves: no index input');
                const node = d.dyno({
                    inTypes: { index: 'int', time: 'float' },
                    outTypes: { gsplat: d.Gsplat },
                    inputs: { index, time: uTime },
                    globals: () => [d.defineGsplat, LEAVES_GLSL],
                    statements: ({ inputs, outputs }) => {
                        const g = outputs.gsplat;
                        const i = inputs;
                        return d.unindentLines(`
                            vec4 r = leafHash(${i.index});
                            vec4 r2 = leafHash(${i.index} + 7919);
                            float life = mix(${f(LIFE[0])}, ${f(LIFE[1])}, r2.x);
                            float age = fract(r.w + ${i.time} / life);
                            // Which life this is, so a leaf leaves from somewhere new each time.
                            float cycle = floor(r.w + ${i.time} / life);
                            vec4 s = leafHash(${i.index} * 31 + int(mod(cycle, 997.0)) * 131);

                            vec4 crown = LEAF_TREES[int(mod(float(${i.index}), ${TREES.length}.0))];

                            // Somewhere in the lower two thirds of the crown.
                            float ang = s.x * 6.28318;
                            float rad = sqrt(s.y) * crown.w * 0.75;
                            vec3 start = crown.xyz + vec3(cos(ang) * rad, (s.z - 0.6) * crown.w * 0.7, sin(ang) * rad);
                            float ground = ${f(GROUND_Y)} + 0.01;

                            // Fall, then lie still. Drift and rocking stop on landing.
                            float fall = min(age / ${f(FALL)}, 1.0);
                            vec2 wind = LEAF_WIND;
                            vec2 across = vec2(-wind.y, wind.x);
                            float t = ${i.time};
                            float swing = sin(t * (1.8 + r2.y) + r.w * 40.0);
                            vec3 pos = start;
                            pos.y = mix(start.y, ground, fall);
                            pos.xz += wind * ${f(DRIFT)} * fall * (0.6 + 0.8 * r2.z);
                            float airborne = 1.0 - step(1.0, fall);
                            // A little lift at each end of the swing.
                            pos.xz += across * swing * ${f(ROCK)} * airborne * (0.5 + r2.w);
                            pos.y += abs(swing) * 0.08 * airborne;

                            // Tumbling on the way down; lying flat once landed.
                            vec3 axis = normalize(r2.yzw - 0.5 + vec3(0.0, 0.0, 0.01));
                            vec4 tumble = quatAxisAngle(axis, t * (2.0 + 2.0 * r.x) + r.y * 20.0);
                            vec4 flat_ = quatMul(quatAxisAngle(vec3(0.0, 1.0, 0.0), r.y * 6.28318),
                                                 quatAxisAngle(vec3(1.0, 0.0, 0.0), -1.5708));
                            vec4 quat = airborne > 0.5 ? tumble : flat_;

                            vec3 col = LEAF_COLORS[int(floor(s.w * ${COLORS.length}.0))];

                            // In at the branch, out on the grass.
                            float alpha = 0.85 * smoothstep(0.0, 0.04, age) * (1.0 - smoothstep(0.9, 1.0, age));
                            float size = 0.8 + 0.4 * r.z;

                            ${g}.center = pos;
                            ${g}.flags = GSPLAT_FLAG_ACTIVE;
                            ${g}.index = ${i.index};
                            ${g}.scales = vec3(${SIZE.map(f).join(', ')}) * size;
                            ${g}.quaternion = quat;
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
            // Without a version bump, Spark doesn't regenerate.
            object.updateVersion();
        },
    });
    // Leaves shouldn't catch the pointer's picking rays.
    object.raycast = () => {};

    return { object };
}
