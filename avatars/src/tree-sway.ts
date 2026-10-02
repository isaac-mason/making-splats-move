/**
 * The trees swaying in the breeze: the wind example's technique (wind/src/wind.ts),
 * cut down to a list of spheres in scene.ts.
 *
 * Splats inside a tree's sphere are displaced at DRAW time, in Spark's splat vertex
 * shader, rather than by regenerating the capture each frame — regenerating would
 * slow every sort, and slow sorts are what make ragdolls come apart (see the README).
 * Anything inside a sphere sways, falling leaves included.
 */

import type { SparkRenderer } from '@sparkjsdev/spark';
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

/** A number as a GLSL float literal. */
const f = (n: number) => n.toFixed(4);
const windAngle = THREE.MathUtils.degToRad(WIND_DIRECTION);

/**
 * The sway kernel, from wind/src/wind-sway.ts (a port of PlayCanvas's GsplatTrees):
 * pinned at the base, freest at the crown, with a bend travelling up the trunk and
 * a flutter on top.
 */
const SWAY_GLSL = /* glsl */ `
uniform vec4 treeSpheres[${MAX_TREES}];
uniform vec4 treeGroups[${MAX_TREES}];
uniform int treeCount;
uniform float treeTime;
uniform float treeHighlight;
uniform vec3 treeAccumOrigin;

const float SWAY_STRENGTH = ${f(STRENGTH)};
const float SWAY_SPEED = ${f(SPEED)};
const float SWAY_GUSTINESS = ${f(GUSTINESS)};
const float SWAY_FLUTTER = ${f(FLUTTER)};
const float SWAY_WAVE_TRAVEL = ${f(WAVE_TRAVEL)};
const float SWAY_SOFT_EDGE = ${f(SOFT_EDGE)};
const vec2 SWAY_WIND = vec2(${f(Math.cos(windAngle))}, ${f(Math.sin(windAngle))});

void treeSphereSway(vec3 pos, vec4 sphere, vec4 group, out float sway, out float height) {
    float dist = distance(pos, sphere.xyz);
    if (dist > sphere.w) {
        sway = 0.0;
        height = 0.0;
        return;
    }
    float span = max(group.z - group.y, 1e-4);
    height = clamp((pos.y - group.y) / span, 0.0, 1.0);
    float inner = sphere.w * (1.0 - SWAY_SOFT_EDGE);
    float edgeFade = 1.0 - smoothstep(inner, sphere.w, dist);
    sway = pow(height, 1.3) * edgeFade;
}

vec3 treeOffset(float t, float treeId, float sway, float height) {
    float phase = fract(treeId * 0.61803) * 6.28318;
    vec2 windDir = SWAY_WIND;
    float osc = sin(t * SWAY_SPEED - height * SWAY_WAVE_TRAVEL + phase);
    float gust = 1.0 + SWAY_GUSTINESS * sin(t * 0.5 + phase);
    float mag = SWAY_STRENGTH * sway * gust * osc;
    float flick = SWAY_STRENGTH * SWAY_FLUTTER * sway * sin(t * SWAY_SPEED * 3.1 + phase * 2.3 + height * 17.0);
    return vec3(windDir.x * mag - windDir.y * flick, 0.0, windDir.y * mag + windDir.x * flick);
}

void applyTreeSway(inout vec3 center, inout vec4 rgba) {
    // The accumulated buffer is camera-relative; the trees are in world space.
    vec3 world = center + treeAccumOrigin;
    float bestSway = 0.0;
    float bestHeight = 0.0;
    float bestTree = -1.0;
    for (int s = 0; s < ${MAX_TREES}; s++) {
        if (s >= treeCount) break;
        float sway, height;
        treeSphereSway(world, treeSpheres[s], treeGroups[s], sway, height);
        // Strongest claim wins, never the sum — a splat in two trees mustn't move twice.
        if (sway > bestSway) {
            bestSway = sway;
            bestHeight = height;
            bestTree = treeGroups[s].x;
        }
    }
    if (bestTree < 0.0) return;
    center += treeOffset(treeTime, bestTree, bestSway, bestHeight);
    // 'tint sway' in the debug panel: show what the wind claims, to check the spheres.
    if (treeHighlight > 0.0) rgba.rgb = mix(rgba.rgb, vec3(1.0, 0.06, 0.04), treeHighlight * mix(0.55, 1.0, bestSway));
}
`;

/** For `new SparkRenderer({ extraUniforms })`, which merges them in at construction. */
export function createSwayUniforms(trees: readonly Tree[] = TREES) {
    const spheres = new Float32Array(MAX_TREES * 4);
    const groups = new Float32Array(MAX_TREES * 4);
    trees.slice(0, MAX_TREES).forEach((tree, i) => {
        spheres.set([...tree.center, tree.radius], i * 4);
        // (treeId, baseY, topY, 0): sway is measured from the bottom of the sphere.
        groups.set([i, tree.center[1] - tree.radius, tree.center[1] + tree.radius, 0], i * 4);
    });
    return {
        treeSpheres: { value: spheres },
        treeGroups: { value: groups },
        treeCount: { value: Math.min(trees.length, MAX_TREES) },
        // Our own clock: Spark's `time` only advances when it regenerates.
        treeTime: { value: 0 },
        treeHighlight: { value: 0 },
        treeAccumOrigin: { value: new THREE.Vector3() },
    };
}

export type SwayUniforms = ReturnType<typeof createSwayUniforms>;

const GLOBALS_ANCHOR = 'uniform usampler2D ordering;';
const CALL_ANCHOR =
    'vec3 viewCenter = (!enableCovSplats ? quatVec(renderToViewQuat, center) : (renderToViewBasis * center)) + renderToViewPos;';

/** Spark workaround: patch the sway into Spark's splat shader by string. Throws if its shader has moved on. */
export function applyTreeSway(spark: SparkRenderer): void {
    const patched = spark.material.vertexShader
        .replace(GLOBALS_ANCHOR, `${SWAY_GLSL}\n${GLOBALS_ANCHOR}`)
        .replace(CALL_ANCHOR, `applyTreeSway(center, rgba);\n    ${CALL_ANCHOR}`);
    if (!patched.includes('applyTreeSway(center, rgba);') || !patched.includes('uniform int treeCount;')) {
        throw new Error('tree sway: splatVertex.glsl anchors not found — did Spark change its splat shader?');
    }
    spark.material.vertexShader = patched;
    spark.material.needsUpdate = true;
}

/** Off puts every tree back at rest, rather than freezing it mid-sway. */
export function setTreeSwayEnabled(uniforms: SwayUniforms, enabled: boolean): void {
    uniforms.treeCount.value = enabled ? Math.min(TREES.length, MAX_TREES) : 0;
}

const ZERO = new THREE.Vector3();

/**
 * Once per frame. Spark stores splats relative to the camera position at the last
 * generate (for float precision), so the spheres are tested against `center + origin`.
 */
export function tickTreeSway(spark: SparkRenderer, uniforms: SwayUniforms, seconds: number): void {
    uniforms.treeTime.value = seconds;
    // Spark workaround: `display` is internal, so reach for it through a cast.
    const display = spark.display as unknown as { extSplats?: unknown; viewOrigin: THREE.Vector3 };
    uniforms.treeAccumOrigin.value.copy(display.extSplats ? ZERO : display.viewOrigin);
}
