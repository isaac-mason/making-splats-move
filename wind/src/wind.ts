import { dyno as d, SplatMesh } from '@sparkjsdev/spark';

/**
 * Wind / sway for the Gaussian splat — Spark's equivalent of PlayCanvas's
 * `gsplatModifyVS` "modifySplatCenter" wind demo.
 *
 * PlayCanvas overrides a scene-wide shader chunk whose `modifySplatCenter` runs
 * once per splat and offsets the center by a time-driven sinusoid. Spark's
 * equivalent is a `GsplatModifier` dyno assigned to `SplatMesh.objectModifier`:
 * it runs once per splat in the generator, receives the `Gsplat`, and returns a
 * modified one. We split it, add a sway offset to the center, and recombine.
 * Time comes for free from the static `SplatMesh.dynoTime` uniform Spark updates
 * every frame.
 *
 * WHICH splats sway is controlled by authored sphere volumes (`WIND_SPHERES`) —
 * the reproduction of PlayCanvas's authored wind spheres. Splats inside a sphere
 * sway fully, feathering to zero at its edge; splats in no sphere stay put. The
 * spheres are baked into the shader as constants (they're authored, not dynamic),
 * and the debug panel's "wind sphere debug" toggle draws the same volumes.
 *
 * Positions are in the splat's native (object-space) units, since the modifier runs
 * before the mesh's own transform. This example leaves the mesh unscaled, so they
 * are also world-space; scale the mesh and these need scaling to match.
 */
export type WindSphere = {
    /** Center in native splat units. */
    center: [number, number, number];
    /** Radius in native splat units. */
    radius: number;
};

/** Authored wind volumes — splats inside these sway. */
export const WIND_SPHERES: WindSphere[] = [
    { center: [0, 8, 5], radius: 5 },
    { center: [0, 10, 5], radius: 5 },
    { center: [4.39, 7.5, -9.04], radius: 4 },
    { center: [4.39, 10, -9.04], radius: 4 },
    { center: [-21.04, 6, 1.87], radius: 4 },
    { center: [-29.04, 6, -0.81], radius: 3 },
    { center: [-21.73, 6, -12.71], radius: 4 },
];

export type WindParams = {
    /** Sway amplitude in native splat units (≈ metres, at this scene's scale). */
    amplitude: number;
    /** Oscillations per second. */
    speed: number;
    /** Fraction of each sphere's radius over which the mask feathers to zero (0..1). */
    softEdge: number;
};

const DEFAULTS: WindParams = { amplitude: 0.07, speed: 1.3, softEdge: 0.35 };

/** GLSL that accumulates the sphere mask (0..1) into `mask` for a given center. */
function sphereMaskGlsl(centerVar: string, spheres: WindSphere[], softEdge: number): string {
    if (spheres.length === 0) return 'float mask = 0.0;';
    const lines = ['float mask = 0.0;'];
    for (const s of spheres) {
        const [x, y, z] = s.center;
        const inner = (s.radius * (1 - softEdge)).toFixed(4);
        const c = `vec3(${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)})`;
        // 1 inside `inner`, feathering to 0 at the full radius.
        lines.push(`mask = max(mask, 1.0 - smoothstep(${inner}, ${s.radius.toFixed(4)}, distance(${centerVar}, ${c})));`);
    }
    // Union (max), never sum: a splat in overlapping spheres gets max(m1, m2),
    // not m1 + m2, so it can't be double-displaced and flung out. Clamp guards it.
    lines.push('mask = clamp(mask, 0.0, 1.0);');
    return lines.join('\n');
}

/**
 * A dyno taking (center, time) -> offset:vec3. Written as raw GLSL because it
 * maps 1:1 onto PlayCanvas's `modifySplatCenter` body and is the clearest place
 * to swap in real noise or a wind direction later.
 */
function swayOffset(center: d.DynoVal<'vec3'>, time: d.DynoVal<'float'>, p: WindParams) {
    return d.dyno({
        inTypes: { center: 'vec3', time: 'float' },
        outTypes: { offset: 'vec3' },
        inputs: { center, time },
        statements: ({ inputs, outputs }) =>
            d.unindentLines(`
                // Authored-sphere mask: which splats sway, and how much.
                ${sphereMaskGlsl(`${inputs.center}`, WIND_SPHERES, p.softEdge)}

                // Per-splat phase so neighbouring foliage doesn't move in lockstep.
                float phase = ${inputs.time} * ${p.speed.toFixed(3)}
                            + ${inputs.center}.x * 0.7
                            + ${inputs.center}.z * 0.7;

                float swayX = sin(phase)             * ${p.amplitude.toFixed(3)}         * mask;
                float swayZ = sin(phase * 1.3 + 1.7) * ${(p.amplitude * 0.6).toFixed(3)} * mask;
                ${outputs.offset} = vec3(swayX, 0.0, swayZ);
            `),
    });
}

/** Build the object-space GsplatModifier. */
export function makeWindModifier(params: Partial<WindParams> = {}) {
    const p = { ...DEFAULTS, ...params };
    return d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
        const split = d.splitGsplat(gsplat as d.DynoVal<typeof d.Gsplat>).outputs;
        const offset = swayOffset(split.center, SplatMesh.dynoTime, p).outputs.offset;
        const center = d.add(split.center, offset);
        return { gsplat: d.combineGsplat({ gsplat, center }) };
    });
}

/** Attach wind to a splat mesh. Call once (before or after load). */
export function applyWind(mesh: SplatMesh, params?: Partial<WindParams>): void {
    mesh.objectModifier = makeWindModifier(params);
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
}
