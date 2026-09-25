import { dyno as d, type SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import windConfig from './wind.json';
import { WIND_SWAY_GLSL } from './wind-sway';

/**
 * Wind / sway for a Gaussian splat — Spark's equivalent of PlayCanvas's
 * `gsplatModifyVS` "modifySplatCenter" wind, and of their `GsplatTrees` script
 * (playcanvas/engine#9022), whose sway model this borrows.
 *
 * A `GsplatModifier` dyno assigned to `SplatMesh.objectModifier` runs once per
 * splat in the generator, receives the `Gsplat`, and returns a modified one. We
 * displace its centre and (in edit mode) tint it. Time is free — Spark updates
 * the static `SplatMesh.dynoTime` uniform every frame.
 *
 * WHICH splats sway is the interesting half. A city can't sway as a whole: the
 * road and buildings have to stay put. So foliage is selected by hand with
 * authored sphere volumes, and each sphere behaves like one tree:
 *
 *   - The sphere's BASE anchors the trunk and its top is the canopy, so sway
 *     scales with height *within the sphere* — squared, giving the cantilever
 *     bend of a real trunk rather than a rigid slab sliding sideways.
 *   - Sway feathers out radially near the sphere's surface, so a tree doesn't
 *     end at a hard spherical cut.
 *   - A splat in several spheres takes the strongest, never the sum — summing
 *     would double-displace it and fling it out of the tree.
 *
 * Unlike the first version of this file, the spheres are NOT baked into the
 * generated GLSL as constants. They live in an array uniform, so the editor
 * (src/wind-editor.ts) can drag one with a gizmo and see the result immediately,
 * with no shader recompile.
 */

/** Upper bound on authored spheres — fixes the uniform array size in the shader. */
export const MAX_SPHERES = 64;

export type WindSphere = {
    /** Centre in native splat units. */
    center: [number, number, number];
    /** Radius in native splat units. */
    radius: number;
    /**
     * Which tree this sphere belongs to. Spheres sharing an id are one tree: they
     * share a phase and measure height from their combined base, so you can stack
     * several to describe a tall canopy without shearing it in half. Defaults to
     * the sphere's own index, i.e. every sphere is its own tree.
     */
    tree?: number;
};

/**
 * Pack each sphere's tree into (treeId, baseY, topY, 0) for the shader — the
 * vertical extent is of the whole TREE, not the sphere, which is what keeps the
 * height continuous where stacked spheres overlap.
 */
export function packSphereGroups(spheres: WindSphere[], out: Float32Array): void {
    const ids = spheres.map((sphere, index) => sphere.tree ?? index);

    const bounds = new Map<number, { lo: number; hi: number }>();
    spheres.forEach((sphere, index) => {
        const lo = sphere.center[1] - sphere.radius;
        const hi = sphere.center[1] + sphere.radius;
        const found = bounds.get(ids[index]);
        if (found) {
            found.lo = Math.min(found.lo, lo);
            found.hi = Math.max(found.hi, hi);
        } else {
            bounds.set(ids[index], { lo, hi });
        }
    });

    out.fill(0);
    spheres.forEach((_, index) => {
        const bound = bounds.get(ids[index]);
        if (bound) out.set([ids[index], bound.lo, bound.hi, 0], index * 4);
    });
}

export type WindParams = {
    /** Peak sway displacement at the canopy, in native splat units. */
    strength: number;
    /** Oscillations per second. */
    speed: number;
    /** Wind heading in degrees, around Y. */
    direction: number;
    /** Slow swell riding on top of the base oscillation (0 = steady breeze). */
    gustiness: number;
    /** High-frequency leaf-scale jitter, as a fraction of `strength`. */
    flutter: number;
    /** How far the bend lags going up the tree — the wave travelling through it. */
    waveTravel: number;
    /** Fraction of each sphere's radius over which the mask feathers out (0..1). */
    softEdge: number;
};

// Both of these come from src/wind.json, which is byte-for-byte what the editor's
// JSON box emits — so authoring a scene is: open edit mode, drag things until it
// looks right, copy, paste over the file. No translation step to get wrong.
export const DEFAULT_PARAMS: WindParams = windConfig.params;

/** Authored wind volumes — splats inside these sway. */
export const DEFAULT_SPHERES: WindSphere[] = windConfig.spheres.map((sphere) => ({
    // Narrow JSON's number[] to the fixed-length tuple the shader expects.
    center: [sphere.center[0], sphere.center[1], sphere.center[2]],
    radius: sphere.radius,
    tree: sphere.tree,
}));

export type Wind = {
    /** The mesh the modifier is attached to. */
    mesh: SplatMesh;
    /** Current authored spheres. Treat as read-only; go through `setSpheres`. */
    spheres: WindSphere[];
    /** Current wind parameters. Treat as read-only; go through `setParams`. */
    params: WindParams;
    /** Replace the authored volumes (up to MAX_SPHERES; extras are dropped). */
    setSpheres(spheres: WindSphere[]): void;
    /** Update any subset of the wind parameters. */
    setParams(params: Partial<WindParams>): void;
    /** Whether the wind blows at all. Off holds every splat still; the params are kept. */
    enabled: boolean;
    setEnabled(enabled: boolean): void;
    /**
     * Tint strength for included splats, 0..1 — the edit-mode "show me the leaves
     * this actually moves" view. 0 disables it entirely.
     */
    setHighlight(amount: number): void;
    /** Index of the sphere being edited; others tint dimmer. -1 for none. */
    setSelected(index: number): void;
    /** Once per frame. Only the draw-time path needs it; the generator path no-ops. */
    tick(elapsedSeconds: number): void;
};

/** `?generator=1` picks the modifier; otherwise the shader patch. */
export type WindPath = 'draw-time' | 'generator';

/**
 * Uniforms for `new SparkRenderer({ extraUniforms })`, and the one set of values
 * both paths read: the draw-time shader patch through the renderer, the generator
 * modifier by handing the same objects to its dyno. So the `Wind` that drives them
 * is identical either way.
 *
 * Called before the renderer exists, because extra uniforms are merged into the
 * splat material at construction.
 */
export function createWindUniforms() {
    return {
        // Sphere volumes as flat arrays, the form three uploads directly:
        // xyz = centre, w = radius; and each sphere's tree, (treeId, baseY, topY, 0).
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
        // happens — so on the draw-time path, whose whole purpose is to stop
        // generating, it sits frozen and nothing moves. Driven from the render loop.
        // (The generator path passes SplatMesh.dynoTime instead.)
        windTime: { value: 0 },
        // The accumulated buffer is NOT in world space — see tickDrawTime. Stays
        // zero on the generator path, whose splats are already in object space.
        windAccumOrigin: { value: new THREE.Vector3() },
    };
}

export type WindUniforms = ReturnType<typeof createWindUniforms>;

/**
 * The per-splat wind, shared by both paths: find the tree that claims this splat,
 * sway it, and in edit mode tint it.
 *
 * The tint colours: red for included, because nothing in a daylit street scene is
 * red — foliage, sky and asphalt are green/blue/grey — so "is this splat in a
 * volume" is never a judgement call. The volume you're editing goes yellow instead,
 * matching its wireframe, so you can read "everything the wind touches" and "the
 * one I'm dragging" off the same picture. Every volume stays strongly tinted
 * either way: dimming the others to pick one out just hides the thing you came to
 * look at.
 */
const WIND_GLSL = /* glsl */ `
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
uniform vec3 windAccumOrigin;

const vec3 WIND_INCLUDED_COLOR = vec3(1.0, 0.06, 0.04);
const vec3 WIND_SELECTED_COLOR = vec3(1.0, 0.85, 0.05);

${WIND_SWAY_GLSL}

void applyWindSway(inout vec3 center, inout vec4 rgba, float t) {
    // Volumes are authored in world space. Lift the centre into it first.
    vec3 worldCenter = center + windAccumOrigin;

    // Find the sphere that claims this splat most strongly. Union by max, never a
    // sum: a splat in two overlapping trees must not be displaced twice and flung
    // out of both.
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

    // Edit mode: tint what the wind actually claims. The tint tracks the sway, so
    // the pinned base reads dark and the free canopy bright — the falloff itself
    // becomes visible. The floor keeps barely-swaying splats clearly tinted.
    if (windHighlight > 0.0) {
        bool isSelected = bestIndex == windSelected;
        vec3 tint = isSelected ? WIND_SELECTED_COLOR : WIND_INCLUDED_COLOR;
        float focus = (windSelected < 0 || isSelected) ? 1.0 : 0.75;
        rgba.rgb = mix(rgba.rgb, tint, windHighlight * focus * mix(0.55, 1.0, bestSway));
    }
}
`;

/** Attach whichever path was chosen. Both return the same `Wind`. */
export function applyWind(path: WindPath, spark: SparkRenderer, mesh: SplatMesh, uniforms: WindUniforms): Wind {
    const wind: Wind = {
        mesh,
        spheres: [],
        params: { ...DEFAULT_PARAMS },
        enabled: true,
        setSpheres(next) {
            const capped = next.slice(0, MAX_SPHERES);
            wind.spheres = capped;
            uniforms.windSpheres.value.fill(0);
            capped.forEach((sphere, s) => {
                uniforms.windSpheres.value.set([...sphere.center, sphere.radius], s * 4);
            });
            packSphereGroups(capped, uniforms.windSphereGroups.value);
            uniforms.windSphereCount.value = capped.length;
        },
        setParams(next) {
            const params = Object.assign(wind.params, next);
            uniforms.windStrength.value = wind.enabled ? params.strength : 0;
            uniforms.windSpeed.value = params.speed;
            uniforms.windDirection.value = THREE.MathUtils.degToRad(params.direction);
            uniforms.windGustiness.value = params.gustiness;
            uniforms.windFlutter.value = params.flutter;
            uniforms.windWaveTravel.value = params.waveTravel;
            uniforms.windSoftEdge.value = params.softEdge;
        },
        setEnabled(enabled) {
            wind.enabled = enabled;
            wind.setParams({});
            // The generator path only moves splats when it regenerates. One more,
            // to settle them back home. (A harmless extra one on the draw-time path.)
            mesh.needsUpdate = true;
        },
        setHighlight(amount) {
            uniforms.windHighlight.value = THREE.MathUtils.clamp(amount, 0, 1);
        },
        setSelected(index) {
            uniforms.windSelected.value = index;
        },
        tick(elapsedSeconds) {
            if (path === 'draw-time') tickDrawTime(spark, uniforms, elapsedSeconds);
        },
    };

    wind.setSpheres(DEFAULT_SPHERES);
    if (path === 'draw-time') applyDrawTimeWind(spark);
    else applyGeneratorWind(wind, uniforms);
    return wind;
}

// ---------------------------------------------------------------------------
// PATH A — generator: a dyno objectModifier, the idiomatic Spark approach.
// ---------------------------------------------------------------------------

function applyGeneratorWind(wind: Wind, uniforms: WindUniforms): void {
    const { mesh } = wind;

    mesh.objectModifier = d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
        const node = d.dyno({
            inTypes: { gsplat: d.Gsplat, time: 'float' },
            outTypes: { gsplat: d.Gsplat },
            inputs: { gsplat, time: SplatMesh.dynoTime },
            generate: ({ inputs: i, outputs: o }) => ({
                globals: [d.defineGsplat, WIND_GLSL],
                statements: [`${o.gsplat} = ${i.gsplat};`, `applyWindSway(${o.gsplat}.center, ${o.gsplat}.rgba, ${i.time});`],
                uniforms,
            }),
        });
        return { gsplat: node.outputs.gsplat };
    });

    mesh.updateGenerator();

    mesh.onFrame = () => {
        if (wind.enabled || uniforms.windHighlight.value > 0) mesh.needsUpdate = true;
    };
}

// ---------------------------------------------------------------------------
// PATH B — draw time: displace splats in Spark's splat shader as they're drawn.
// ---------------------------------------------------------------------------

/**
 * The default.
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
 *
 * Note there's no `objectModifier` and no `onFrame` here — that's the entire point.
 * Nothing bumps the generator's version, so the splat buffer is never regenerated
 * for the wind's sake.
 */

const GLOBALS_ANCHOR = 'uniform usampler2D ordering;';
const CALL_ANCHOR =
    'vec3 viewCenter = (!enableCovSplats ? quatVec(renderToViewQuat, center) : (renderToViewBasis * center)) + renderToViewPos;';

function applyDrawTimeWind(spark: SparkRenderer): void {
    const patched = spark.material.vertexShader
        .replace(GLOBALS_ANCHOR, `${WIND_GLSL}\n${GLOBALS_ANCHOR}`)
        .replace(CALL_ANCHOR, `applyWindSway(center, rgba, windTime);\n    ${CALL_ANCHOR}`);

    // fail loudly
    if (!patched.includes('applyWindSway(center, rgba, windTime);') || !patched.includes('uniform int windSphereCount;')) {
        throw new Error('draw-time wind: splatVertex.glsl anchors not found — did Spark change its splat shader?');
    }

    spark.material.vertexShader = patched;
    spark.material.needsUpdate = true; // force a recompile with the injected code
}

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
function tickDrawTime(spark: SparkRenderer, uniforms: WindUniforms, elapsedSeconds: number): void {
    uniforms.windTime.value = elapsedSeconds;
    const display = spark.display as unknown as { extSplats?: unknown; viewOrigin: THREE.Vector3 };
    uniforms.windAccumOrigin.value.copy(display.extSplats ? ZERO : display.viewOrigin);
}
