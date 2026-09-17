import type { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import {
    DEFAULT_PARAMS,
    DEFAULT_SPHERES,
    MAX_SPHERES,
    packSphereGroups,
    type Wind,
    type WindParams,
    type WindSphere,
} from './wind';
import { WIND_SWAY_GLSL } from './wind-sway';

/**
 * The default wind path: displace splats in Spark's DRAW-time splat shader rather
 * than in the generator. (`?generator=1` switches to src/wind.ts instead.)
 *
 * The generator path has to regenerate the whole splat buffer every frame, because
 * moving a splat invalidates the sort order it was placed in — and Spark responds
 * by re-sorting, which means reading depths back from the GPU. That readback is the
 * real cost of animated splats in Spark, and it dwarfs the regeneration itself.
 *
 * PlayCanvas's classic gsplat path instead displaces splats in the vertex shader at
 * draw time, skipping all of it and accepting that the sort is then computed from
 * where the splats *were*. This is that approach, in Spark.
 *
 * Spark supports it directly: `SparkRendererOptions.vertexShader` replaces the
 * splat shader and `extraUniforms` merges into its uniform map. But rather than
 * vendoring a copy of `splatVertex.glsl` — 270 lines of ExtSplats / CovSplats / LOD
 * / 2DGS handling we'd then own forever — we patch the shader string on the live
 * material. That way we track whatever Spark ships and own only what we inject,
 * and a changed anchor fails loudly instead of silently drifting.
 *
 * KNOWN LIMITS of this path:
 *  - The sort is stale by one displacement. Fine at wind amplitudes; wrong for
 *    large motion.
 *  - The shader draws the WHOLE accumulated buffer — every visible SplatMesh and
 *    SplatGenerator merged. This example has exactly one mesh, so everything in
 *    the buffer is ours. With more, you'd gate on the splat's index against the
 *    `{ base, count }` range for your mesh in `SplatAccumulator.mapping`.
 */

// Anchors into Spark's own splat shader. Both are CODE, deliberately: the
// published build strips comments out of the GLSL, so anchoring on one silently
// matches nothing. (Found the hard way — hence the assertion below.)
/** The first of the splat-data samplers, at the end of the uniform block. */
const GLOBALS_ANCHOR = 'uniform usampler2D ordering;';
/** The splat is unpacked by here, and `center` is used on this very line. */
const CALL_ANCHOR =
    'vec3 viewCenter = (!enableCovSplats ? quatVec(renderToViewQuat, center) : (renderToViewBasis * center)) + renderToViewPos;';

const INCLUDED_COLOR = 'vec3(1.0, 0.06, 0.04)';
const SELECTED_COLOR = 'vec3(1.0, 0.85, 0.05)';

const GLOBALS_GLSL = /* glsl */ `
uniform vec4 windSpheres[${MAX_SPHERES}];
uniform vec4 windSphereGroups[${MAX_SPHERES}];
uniform int windSphereCount;
uniform float windStrength;
uniform float windSpeed;
uniform float windDirection;
uniform float windGustiness;
uniform float windFlutter;
uniform float windWaveTravel;
uniform float windSoftEdge;
uniform float windHighlight;
uniform int windSelected;
uniform float windTime;
// The accumulated buffer is NOT in world space — see the note in applyDrawTimeWind.
uniform vec3 windAccumOrigin;

${WIND_SWAY_GLSL}

void applyWindSway(inout vec3 center, inout vec4 rgba, float t) {
    // Volumes are authored in world space; this center is not. Lift it first.
    vec3 worldCenter = center + windAccumOrigin;

    int bestIndex = -1;
    float bestTree = 0.0;
    float bestSway = 0.0;
    float bestHeight = 0.0;

    for (int s = 0; s < ${MAX_SPHERES}; s++) {
        if (s >= windSphereCount) break;
        vec4 sphere = windSpheres[s];
        if (sphere.w <= 0.0) continue;

        float sway, height;
        windSphereSway(worldCenter, sphere, windSphereGroups[s], windSoftEdge, sway, height);
        if (sway > bestSway) {
            bestSway = sway;
            bestHeight = height;
            bestIndex = s;
            bestTree = windSphereGroups[s].x;
        }
    }

    if (bestIndex < 0) return;

    center += windOffset(
        t, bestTree, bestSway, bestHeight,
        windStrength, windSpeed, windDirection,
        windGustiness, windFlutter, windWaveTravel
    );

    if (windHighlight > 0.0) {
        bool isSelected = windSelected >= 0 && bestIndex == windSelected;
        vec3 tint = isSelected ? ${SELECTED_COLOR} : ${INCLUDED_COLOR};
        float focus = (windSelected < 0 || isSelected) ? 1.0 : 0.75;
        float amount = windHighlight * focus * mix(0.55, 1.0, bestSway);
        rgba.rgb = mix(rgba.rgb, tint, amount);
    }
}

${GLOBALS_ANCHOR}`;

type Uniforms = Record<string, { value: unknown }>;

/**
 * Build the uniform map. Must be handed to `new SparkRenderer({ extraUniforms })`,
 * so this is called before the renderer exists.
 */
export function createDrawTimeUniforms(): Uniforms {
    return {
        // three's ShaderMaterial doesn't auto-declare custom uniforms, hence the
        // matching declarations in GLOBALS_GLSL above.
        windSpheres: { value: new Float32Array(MAX_SPHERES * 4) },
        windSphereGroups: { value: new Float32Array(MAX_SPHERES * 4) },
        windSphereCount: { value: 0 },
        windStrength: { value: DEFAULT_PARAMS.strength },
        windSpeed: { value: DEFAULT_PARAMS.speed },
        windDirection: { value: THREE.MathUtils.degToRad(DEFAULT_PARAMS.direction) },
        windGustiness: { value: DEFAULT_PARAMS.gustiness },
        windFlutter: { value: DEFAULT_PARAMS.flutter },
        windWaveTravel: { value: DEFAULT_PARAMS.waveTravel },
        windSoftEdge: { value: DEFAULT_PARAMS.softEdge },
        windHighlight: { value: 0 },
        windSelected: { value: -1 },
        // Our own clock, NOT Spark's built-in `time` uniform. That one is assigned
        // from `spark.display.time`, which only advances when a generate actually
        // happens — so on this path, whose whole purpose is to stop generating, it
        // sits frozen and nothing moves. Driven from the render loop instead.
        windTime: { value: 0 },
        windAccumOrigin: { value: new THREE.Vector3() },
    };
}

/**
 * Patch the live splat shader, and return a `Wind` that drives it. The returned
 * object has the same shape as `applyWind`'s, so the editor can't tell them apart.
 *
 * Note there's no `objectModifier` and no `onFrame` here — that's the entire point.
 * Nothing bumps the generator's version, so the splat buffer is never regenerated
 * for the wind's sake.
 */
const ZERO = new THREE.Vector3();

/**
 * Advance the draw-time clock and re-sync the accumulator origin. Call once per
 * frame from the render loop.
 *
 * The origin matters and is easy to miss: Spark does NOT store splat centres in
 * world space. For float precision it offsets the whole accumulated buffer by the
 * camera's position at the moment it was generated —
 *
 *     if (!display.extSplats) accumToWorld.makeTranslation(display.viewOrigin)
 *
 * — so a shader reading `center` is working in a camera-relative space that shifts
 * every time a regeneration happens. Authored world-space volumes have to be
 * compared against `center + viewOrigin`, or they miss by however far the camera
 * is from the origin. (The ExtSplats path keeps world space, hence the branch.)
 */
export function tickDrawTimeWind(spark: SparkRenderer, uniforms: Uniforms, elapsedSeconds: number): void {
    uniforms.windTime.value = elapsedSeconds;
    const display = spark.display as unknown as { extSplats?: unknown; viewOrigin: THREE.Vector3 };
    (uniforms.windAccumOrigin.value as THREE.Vector3).copy(display.extSplats ? ZERO : display.viewOrigin);
}

export function applyDrawTimeWind(spark: SparkRenderer, mesh: SplatMesh, uniforms: Uniforms): Wind {
    const source = spark.material.vertexShader;

    const patched = source
        .replace(GLOBALS_ANCHOR, GLOBALS_GLSL)
        .replace(CALL_ANCHOR, `applyWindSway(center, rgba, windTime);\n    ${CALL_ANCHOR}`);

    // Fail loudly. A silent no-op here would look like "the wind stopped working"
    // after a Spark upgrade, with nothing pointing at the cause.
    if (!patched.includes('applyWindSway(center, rgba, windTime);') || !patched.includes('uniform int windSphereCount;')) {
        throw new Error('draw-time wind: splatVertex.glsl anchors not found — did Spark change its splat shader?');
    }

    spark.material.vertexShader = patched;
    spark.material.needsUpdate = true; // force a recompile with the injected code

    const params: WindParams = { ...DEFAULT_PARAMS };
    const sphereData = uniforms.windSpheres.value as Float32Array;
    const groupData = uniforms.windSphereGroups.value as Float32Array;

    const wind: Wind = {
        mesh,
        spheres: [],
        params,
        setSpheres(next) {
            const capped = next.slice(0, MAX_SPHERES);
            wind.spheres = capped;
            sphereData.fill(0);
            capped.forEach((sphere, s) => {
                sphereData.set([sphere.center[0], sphere.center[1], sphere.center[2], sphere.radius], s * 4);
            });
            packSphereGroups(capped, groupData);
            uniforms.windSphereCount.value = capped.length;
        },
        setParams(next) {
            Object.assign(params, next);
            uniforms.windStrength.value = params.strength;
            uniforms.windSpeed.value = params.speed;
            uniforms.windDirection.value = THREE.MathUtils.degToRad(params.direction);
            uniforms.windGustiness.value = params.gustiness;
            uniforms.windFlutter.value = params.flutter;
            uniforms.windWaveTravel.value = params.waveTravel;
            uniforms.windSoftEdge.value = params.softEdge;
        },
        setHighlight(amount) {
            uniforms.windHighlight.value = THREE.MathUtils.clamp(amount, 0, 1);
        },
        setSelected(index) {
            uniforms.windSelected.value = index;
        },
    };

    wind.setSpheres(DEFAULT_SPHERES as WindSphere[]);
    return wind;
}
