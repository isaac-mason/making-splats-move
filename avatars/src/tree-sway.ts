/**
 * The trees swaying in the breeze: the wind example's technique (wind/src/wind.ts),
 * cut down to a list of spheres in scene.ts.
 *
 * The renderer's modifier, in world space: every splat drawn (the capture, the
 * leaves, the avatars) is tested against the trees' spheres, and anything inside
 * one sways. Uniforms only, so nothing recompiles: the spheres, the clock, the count.
 */

import { type SplatModifier, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { TREES, type Tree } from './scene';

/** Fixes the uniform array size in the shader. */
const MAX_TREES = 8;

/** Breeze, in metres and seconds. Gentle: a courtyard, not a storm. */
const STRENGTH = 0.22;
const SPEED = 0.9;
/** Degrees around Y. The leaves drift this way too. */
export const WIND_DIRECTION = 40;
const GUSTINESS = 0.45;
const FLUTTER = 0.3;
const WAVE_TRAVEL = 2.5;
const SOFT_EDGE = 0.25;

const {
    If,
    Loop,
    clamp,
    distance,
    float,
    fract,
    int,
    max,
    mix,
    pow,
    select,
    sin,
    smoothstep,
    uniform,
    uniformArray,
    vec2,
    vec3,
} = TSL;

const windAngle = THREE.MathUtils.degToRad(WIND_DIRECTION);

export type TreeSway = {
    modifier: SplatModifier;
    count: TslNode;
    time: TslNode;
    highlight: TslNode;
};

export function createTreeSway(trees: readonly Tree[] = TREES): TreeSway {
    const spheres = uniformArray(
        Array.from({ length: MAX_TREES }, (_, i) => {
            const tree = trees[i];
            return tree ? new THREE.Vector4(...tree.center, tree.radius) : new THREE.Vector4();
        }),
        'vec4',
    );
    // (treeId, baseY, topY, 0): sway is measured from the bottom of the sphere.
    const groups = uniformArray(
        Array.from({ length: MAX_TREES }, (_, i) => {
            const tree = trees[i];
            return tree
                ? new THREE.Vector4(i, tree.center[1] - tree.radius, tree.center[1] + tree.radius, 0)
                : new THREE.Vector4();
        }),
        'vec4',
    );
    const count = uniform(Math.min(trees.length, MAX_TREES), 'int');
    const time = uniform(0);
    const highlight = uniform(0);
    const wind = vec2(Math.cos(windAngle), Math.sin(windAngle));

    /**
     * The sway kernel, from wind/src/wind-sway.ts (a port of PlayCanvas's GsplatTrees):
     * pinned at the base, freest at the crown, with a bend travelling up the trunk and
     * a flutter on top. Strongest claim wins, never the sum: a splat in two trees
     * mustn't move twice.
     */
    const modifier: SplatModifier = (splat) => {
        const out = splat.toVar();
        const pos = splat.get('center').toVar();
        const bestSway = float(0).toVar();
        const bestHeight = float(0).toVar();
        const bestTree = float(-1).toVar();

        Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }: { i: TslNode }) => {
            const sphere = spheres.element(i).toVar();
            const group = groups.element(i).toVar();
            const dist = distance(pos, sphere.xyz).toVar();
            const span = max(group.z.sub(group.y), 1e-4);
            const height = clamp(pos.y.sub(group.y).div(span), 0, 1).toVar();
            const inner = sphere.w.mul(1 - SOFT_EDGE);
            const edgeFade = smoothstep(inner, sphere.w, dist).oneMinus();
            const sway = select(dist.greaterThan(sphere.w), float(0), pow(height, 1.3).mul(edgeFade)).toVar();
            If(sway.greaterThan(bestSway), () => {
                bestSway.assign(sway);
                bestHeight.assign(height);
                bestTree.assign(group.x);
            });
        });

        If(bestTree.greaterThanEqual(0), () => {
            const phase = fract(bestTree.mul(0.61803)).mul(6.28318);
            const osc = sin(time.mul(SPEED).sub(bestHeight.mul(WAVE_TRAVEL)).add(phase));
            const gust = sin(time.mul(0.5).add(phase)).mul(GUSTINESS).add(1);
            const mag = bestSway.mul(gust).mul(osc).mul(STRENGTH);
            const flick = bestSway
                .mul(
                    sin(
                        time
                            .mul(SPEED * 3.1)
                            .add(phase.mul(2.3))
                            .add(bestHeight.mul(17)),
                    ),
                )
                .mul(STRENGTH * FLUTTER);
            const offset = vec3(wind.x.mul(mag).sub(wind.y.mul(flick)), 0, wind.y.mul(mag).add(wind.x.mul(flick)));
            out.get('center').assign(pos.add(offset));
            // 'tint sway' in the debug panel: show what the wind claims, to check the spheres.
            If(highlight.greaterThan(0), () => {
                const rgb = out.get('rgb');
                rgb.assign(mix(rgb, vec3(1.0, 0.06, 0.04), highlight.mul(mix(0.55, 1.0, bestSway))));
            });
        });

        return out;
    };

    return { modifier, count, time, highlight };
}

/** Off puts every tree back at rest, rather than freezing it mid-sway. */
export function setTreeSwayEnabled(sway: TreeSway, enabled: boolean): void {
    sway.count.value = enabled ? Math.min(TREES.length, MAX_TREES) : 0;
}

export function tickTreeSway(sway: TreeSway, seconds: number): void {
    sway.time.value = seconds;
}
