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

/**
 * Colours included splats are tinted toward while edit mode is on.
 *
 * Red for included, because nothing in a daylit street scene is red — foliage, sky
 * and asphalt are green/blue/grey — so "is this splat in a volume" is never a
 * judgement call. The volume you're editing goes yellow instead, matching its
 * wireframe, so you can read "everything the wind touches" and "the one I'm
 * dragging" off the same picture. Every volume stays strongly tinted either way:
 * dimming the others to pick one out just hides the thing you came to look at.
 */
const INCLUDED_COLOR = new THREE.Vector3(1.0, 0.06, 0.04);
const SELECTED_COLOR = new THREE.Vector3(1.0, 0.85, 0.05);
/** The same two, as GLSL literals for the draw-time path's shader source. */
const glslVec3 = (v: THREE.Vector3) => `vec3(${v.x}, ${v.y}, ${v.z})`;

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

export type WindUniforms = Record<string, { value: unknown }>;

/**
 * Uniforms for `new SparkRenderer({ extraUniforms })`.
 *
 * Called before the renderer exists, because the draw-time path's uniforms are
 * merged into the splat material at construction. Empty for the generator path.
 */
export function createWindUniforms(path: WindPath): WindUniforms {
    return path === 'draw-time' ? drawTimeUniforms() : {};
}

/** Attach whichever path was chosen. Both return the same `Wind`. */
export function applyWind(path: WindPath, spark: SparkRenderer, mesh: SplatMesh, uniforms: WindUniforms): Wind {
    return path === 'draw-time' ? applyDrawTimeWind(spark, mesh, uniforms) : applyGeneratorWind(mesh);
}

// ---------------------------------------------------------------------------
// PATH A — generator: a dyno objectModifier, the idiomatic Spark approach.
// ---------------------------------------------------------------------------

function applyGeneratorWind(mesh: SplatMesh, spheres = DEFAULT_SPHERES, params: Partial<WindParams> = {}): Wind {
    const resolved: WindParams = { ...DEFAULT_PARAMS, ...params };

    // Sphere volumes as an array uniform: xyz = centre, w = radius. Giving a
    // DynoUniform a `count` makes Spark declare `uniform vec4 <name>[MAX_SPHERES]`.
    // The backing store is one flat Float32Array rather than an array of Vector4s —
    // that's the form three uploads directly, with no per-element marshalling.
    const sphereData = new Float32Array(MAX_SPHERES * 4);
    const uSpheres = new d.DynoUniform({
        key: 'windSpheres',
        type: 'vec4',
        count: MAX_SPHERES,
        value: sphereData,
    });
    // Per-sphere tree data: (treeId, baseY, topY, 0).
    const groupData = new Float32Array(MAX_SPHERES * 4);
    const uGroups = new d.DynoUniform({
        key: 'windSphereGroups',
        type: 'vec4',
        count: MAX_SPHERES,
        value: groupData,
    });
    const uSphereCount = d.dynoInt(0);

    const uStrength = d.dynoFloat(resolved.strength);
    const uSpeed = d.dynoFloat(resolved.speed);
    const uDirection = d.dynoFloat(THREE.MathUtils.degToRad(resolved.direction));
    const uGustiness = d.dynoFloat(resolved.gustiness);
    const uFlutter = d.dynoFloat(resolved.flutter);
    const uWaveTravel = d.dynoFloat(resolved.waveTravel);
    const uSoftEdge = d.dynoFloat(resolved.softEdge);
    const uHighlight = d.dynoFloat(0);
    const uSelected = d.dynoInt(-1);

    const modifier = d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
        if (!gsplat) throw new Error('wind modifier: no gsplat input');

        const node = d.dyno({
            inTypes: {
                gsplat: d.Gsplat,
                spheres: 'vec4',
                groups: 'vec4',
                sphereCount: 'int',
                time: 'float',
                strength: 'float',
                speed: 'float',
                direction: 'float',
                gustiness: 'float',
                flutter: 'float',
                waveTravel: 'float',
                softEdge: 'float',
                highlight: 'float',
                selected: 'int',
            },
            outTypes: { gsplat: d.Gsplat },
            inputs: {
                gsplat,
                spheres: uSpheres,
                groups: uGroups,
                sphereCount: uSphereCount,
                time: SplatMesh.dynoTime, // auto-updated by the SparkRenderer each frame
                strength: uStrength,
                speed: uSpeed,
                direction: uDirection,
                gustiness: uGustiness,
                flutter: uFlutter,
                waveTravel: uWaveTravel,
                softEdge: uSoftEdge,
                highlight: uHighlight,
                selected: uSelected,
            },
            globals: () => [d.defineGsplat, WIND_SWAY_GLSL],
            statements: ({ inputs, outputs }) => {
                const g = outputs.gsplat;
                const i = inputs;
                return d.unindentLines(`
                    ${g} = ${i.gsplat};

                    vec3 windCenter = ${i.gsplat}.center;

                    // Find the sphere that claims this splat most strongly. Union by
                    // max, never a sum: a splat in two overlapping trees must not be
                    // displaced twice and flung out of both.
                    int bestIndex = -1;
                    float bestTree = 0.0;
                    float bestSway = 0.0;
                    float bestHeight = 0.0;
                    for (int s = 0; s < ${MAX_SPHERES}; s++) {
                        if (s >= ${i.sphereCount}) break;
                        vec4 sphere = ${i.spheres}[s];
                        if (sphere.w <= 0.0) continue;

                        float sway, height;
                        windSphereSway(windCenter, sphere, ${i.groups}[s], ${i.softEdge}, sway, height);
                        if (sway > bestSway) {
                            bestSway = sway;
                            bestHeight = height;
                            bestIndex = s;
                            bestTree = ${i.groups}[s].x;
                        }
                    }

                    if (bestIndex >= 0) {
                        ${g}.center = windCenter + windOffset(
                            ${i.time}, bestTree, bestSway, bestHeight,
                            ${i.strength}, ${i.speed}, ${i.direction},
                            ${i.gustiness}, ${i.flutter}, ${i.waveTravel}
                        );

                        // Edit mode: tint what the wind actually claims. The tint
                        // tracks the sway factor, so the pinned base reads dark and
                        // the free canopy bright — the falloff itself becomes visible.
                        if (${i.highlight} > 0.0) {
                            bool isSelected = ${i.selected} >= 0 && bestIndex == ${i.selected};
                            vec3 tint = isSelected
                                ? ${glslVec3(SELECTED_COLOR)}
                                : ${glslVec3(INCLUDED_COLOR)};

                            // Unselected volumes stay clearly tinted rather than
                            // fading out — selection changes the hue, not whether
                            // you can still see what else the wind claims.
                            float focus = (${i.selected} < 0 || isSelected) ? 1.0 : 0.75;

                            // The floor keeps barely-swaying splats clearly tinted —
                            // inclusion has to read on its own, with the sway gradient
                            // on top of it rather than instead of it.
                            float amount = ${i.highlight} * focus * mix(0.55, 1.0, bestSway);
                            ${g}.rgba = vec4(mix(${i.gsplat}.rgba.rgb, tint, amount), ${i.gsplat}.rgba.a);
                        }
                    }
                `);
            },
        });

        return { gsplat: node.outputs.gsplat };
    });

    const wind: Wind = {
        mesh,
        spheres: [],
        params: resolved,
        setSpheres(next) {
            const capped = next.slice(0, MAX_SPHERES);
            wind.spheres = capped;
            sphereData.fill(0);
            capped.forEach((sphere, s) => {
                sphereData.set([sphere.center[0], sphere.center[1], sphere.center[2], sphere.radius], s * 4);
            });
            packSphereGroups(capped, groupData);
            uSphereCount.value = capped.length;
        },
        setParams(next) {
            Object.assign(wind.params, next);
            uStrength.value = wind.params.strength;
            uSpeed.value = wind.params.speed;
            uDirection.value = THREE.MathUtils.degToRad(wind.params.direction);
            uGustiness.value = wind.params.gustiness;
            uFlutter.value = wind.params.flutter;
            uWaveTravel.value = wind.params.waveTravel;
            uSoftEdge.value = wind.params.softEdge;
        },
        setHighlight(amount) {
            uHighlight.value = THREE.MathUtils.clamp(amount, 0, 1);
        },
        setSelected(index) {
            uSelected.value = index;
        },
        // The generator reads SplatMesh.dynoTime, which SparkRenderer advances.
        tick() {},
    };

    wind.setSpheres(spheres);

    mesh.objectModifier = modifier;
    mesh.updateGenerator(); // rebuild the generator program with the modifier

    // The modifier only re-runs when the mesh's version bumps. Spark bumps it on
    // camera/transform changes, so without this the sway would animate only while
    // the camera moves and freeze when it's still. Marking the mesh dirty every
    // frame (via Spark's per-frame onFrame hook) forces the generator — and thus
    // our time-driven offset — to re-run continuously.
    //
    // Cost: this regenerates the whole splat buffer each frame (Spark has no
    // partial regen), the inherent price of an animated modifier. Fine for this
    // scene; if it ever bites, gate it behind a "wind enabled" flag.
    mesh.onFrame = () => {
        mesh.needsUpdate = true;
    };

    return wind;
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
 */

// Anchors into Spark's own splat shader. Both are CODE, deliberately: the
// published build strips comments out of the GLSL, so anchoring on one silently
// matches nothing. (Found the hard way — hence the assertion below.)
/** The first of the splat-data samplers, at the end of the uniform block. */
const GLOBALS_ANCHOR = 'uniform usampler2D ordering;';
/** The splat is unpacked by here, and `center` is used on this very line. */
const CALL_ANCHOR =
    'vec3 viewCenter = (!enableCovSplats ? quatVec(renderToViewQuat, center) : (renderToViewBasis * center)) + renderToViewPos;';

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
        vec3 tint = isSelected ? ${glslVec3(SELECTED_COLOR)} : ${glslVec3(INCLUDED_COLOR)};
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
function drawTimeUniforms(): Uniforms {
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
function tickDrawTime(spark: SparkRenderer, uniforms: Uniforms, elapsedSeconds: number): void {
    uniforms.windTime.value = elapsedSeconds;
    const display = spark.display as unknown as { extSplats?: unknown; viewOrigin: THREE.Vector3 };
    (uniforms.windAccumOrigin.value as THREE.Vector3).copy(display.extSplats ? ZERO : display.viewOrigin);
}

function applyDrawTimeWind(spark: SparkRenderer, mesh: SplatMesh, uniforms: Uniforms): Wind {
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
        tick(elapsedSeconds) {
            tickDrawTime(spark, uniforms, elapsedSeconds);
        },
    };

    wind.setSpheres(DEFAULT_SPHERES as WindSphere[]);
    return wind;
}
