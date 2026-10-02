import type { SparkRenderer } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { TREES, type Tree } from './scene';

/**
 * The courtyard's trees, swaying in the breeze — the wind example's technique, cut
 * down to what this scene needs. See wind/src/wind.ts for the full story, and its
 * editor for authoring volumes; here they're just a list in scene.ts.
 *
 * Splats inside each tree's sphere are displaced at DRAW time, in Spark's splat
 * vertex shader, rather than by regenerating the capture every frame. That matters
 * more here than in wind: the avatars already keep Spark sorting continuously, and
 * regenerating hundreds of thousands of scenery splats on top would slow every sort
 * — which is exactly what makes ragdolls come apart (see the README). Drawn this
 * way, the sway costs one sphere test per splat and nothing else.
 *
 * Anything that wanders into a sphere sways too — the falling leaves, near the top
 * of their fall, which is right. The walkers never get that far.
 */

/** Upper bound on trees — fixes the uniform array size in the shader. */
const MAX_TREES = 8;

/** Breeze settings, in metres and seconds. Gentle: this is a courtyard, not a storm. */
const STRENGTH = 0.22;
const SPEED = 0.9;
/** Heading in degrees around Y. Matches the leaves' drift, so they agree about the wind. */
export const WIND_DIRECTION = 40;
const GUSTINESS = 0.45;
const FLUTTER = 0.3;
const WAVE_TRAVEL = 2.5;
const SOFT_EDGE = 0.25;

/**
 * The sway kernel, copied from wind/src/wind-sway.ts (which ports PlayCanvas's
 * GsplatTrees). Sway grows with height through the tree — pinned at the base,
 * freest at the crown — with a bend that travels up the trunk and a leaf-scale
 * flutter on top.
 */
const SWAY_GLSL = /* glsl */ `
uniform vec4 treeSpheres[${MAX_TREES}];
uniform vec4 treeGroups[${MAX_TREES}];
uniform int treeCount;
uniform float treeTime;
uniform float treeHighlight;
uniform vec3 treeAccumOrigin;

void treeSphereSway(vec3 pos, vec4 sphere, vec4 group, out float sway, out float height) {
    float dist = distance(pos, sphere.xyz);
    if (dist > sphere.w) {
        sway = 0.0;
        height = 0.0;
        return;
    }
    float span = max(group.z - group.y, 1e-4);
    height = clamp((pos.y - group.y) / span, 0.0, 1.0);
    float inner = sphere.w * (1.0 - ${SOFT_EDGE.toFixed(3)});
    float edgeFade = 1.0 - smoothstep(inner, sphere.w, dist);
    sway = pow(height, 1.3) * edgeFade;
}

vec3 treeOffset(float t, float treeId, float sway, float height) {
    float phase = fract(treeId * 0.61803) * 6.28318;
    float direction = ${THREE.MathUtils.degToRad(WIND_DIRECTION).toFixed(5)};
    vec2 windDir = vec2(cos(direction), sin(direction));
    float osc = sin(t * ${SPEED.toFixed(3)} - height * ${WAVE_TRAVEL.toFixed(3)} + phase);
    float gust = 1.0 + ${GUSTINESS.toFixed(3)} * sin(t * 0.5 + phase);
    float mag = ${STRENGTH.toFixed(3)} * sway * gust * osc;
    float flick = ${STRENGTH.toFixed(3)} * ${FLUTTER.toFixed(3)} * sway
        * sin(t * ${SPEED.toFixed(3)} * 3.1 + phase * 2.3 + height * 17.0);
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
    // \`?sway\`: tint what the wind claims, so the spheres can be checked against the trees.
    if (treeHighlight > 0.0) rgba.rgb = mix(rgba.rgb, vec3(1.0, 0.06, 0.04), treeHighlight * mix(0.55, 1.0, bestSway));
}
`;

/**
 * Uniforms for `new SparkRenderer({ extraUniforms })`. Has to be called before the
 * renderer exists: extra uniforms are merged into its material at construction.
 */
export function createSwayUniforms(trees: readonly Tree[] = TREES, highlight = false) {
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
        // Our own clock: Spark's `time` only advances when it regenerates, and the
        // whole point of drawing the sway is that nothing regenerates for it.
        treeTime: { value: 0 },
        treeHighlight: { value: highlight ? 1 : 0 },
        treeAccumOrigin: { value: new THREE.Vector3() },
    };
}

export type SwayUniforms = ReturnType<typeof createSwayUniforms>;

const GLOBALS_ANCHOR = 'uniform usampler2D ordering;';
const CALL_ANCHOR =
    'vec3 viewCenter = (!enableCovSplats ? quatVec(renderToViewQuat, center) : (renderToViewBasis * center)) + renderToViewPos;';

/** Patch the sway into Spark's splat shader. Throws if Spark's shader has moved on. */
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

/** Off puts every tree back at rest — no trees claim any splats — rather than freezing them mid-sway. */
export function setTreeSwayEnabled(uniforms: SwayUniforms, enabled: boolean): void {
    uniforms.treeCount.value = enabled ? Math.min(TREES.length, MAX_TREES) : 0;
}

const ZERO = new THREE.Vector3();

/**
 * Once per frame: advance the clock and re-sync the buffer's origin. Spark offsets
 * the accumulated splats by the camera position at the last generate (for float
 * precision), so world-space spheres have to be compared against `center + origin`.
 */
export function tickTreeSway(spark: SparkRenderer, uniforms: SwayUniforms, seconds: number): void {
    uniforms.treeTime.value = seconds;
    const display = spark.display as unknown as { extSplats?: unknown; viewOrigin: THREE.Vector3 };
    uniforms.treeAccumOrigin.value.copy(display.extSplats ? ZERO : display.viewOrigin);
}
