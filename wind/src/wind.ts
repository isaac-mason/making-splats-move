/**
 * Wind / sway for a Gaussian splat — the equivalent of PlayCanvas's
 * `gsplatModifyVS` "modifySplatCenter" wind, and of their `GsplatTrees` script
 * (playcanvas/engine#9022), whose sway model this borrows.
 *
 * A `SplatModifier` on the capture's generator (`SplatGenerator.fromSplats({
 * modifiers })`) runs once per splat in object space, receives the splat and
 * returns a modified one. We displace its centre and (in edit mode) tint it.
 * The capture sits at the origin, so object space is world space, where the
 * volumes are authored.
 *
 * WHICH splats sway is the interesting half. A city can't sway as a whole: the
 * road and buildings have to stay put. So foliage is selected by hand with
 * authored sphere volumes, and each sphere behaves like one tree:
 *
 *   - The sphere's BASE anchors the trunk and its top is the canopy, so sway
 *     scales with height *within the sphere* — giving the cantilever bend of a
 *     real trunk rather than a rigid slab sliding sideways.
 *   - Sway feathers out radially near the sphere's surface, so a tree doesn't
 *     end at a hard spherical cut.
 *   - A splat in several spheres takes the strongest, never the sum — summing
 *     would double-displace it and fling it out of the tree.
 *
 * The spheres are NOT baked into the shader as constants. They live in uniform
 * arrays, so the editor (src/wind-editor.ts) can drag one with a gizmo and see
 * the result immediately, with no shader recompile.
 */

import { type SplatModifier, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import windConfig from './wind.json';
import { windOffset, windSphereSway } from './wind-sway';

const { If, Loop, float, int, mix, select, uniform, uniformArray, vec3 } = TSL;

/* authored data */

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
export function packSphereGroups(spheres: WindSphere[], out: THREE.Vector4[]): void {
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

    for (const group of out) group.set(0, 0, 0, 0);
    spheres.forEach((_, index) => {
        const bound = bounds.get(ids[index]);
        if (bound) out[index].set(ids[index], bound.lo, bound.hi, 0);
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

/* the wind */

export type Wind = {
    /** Put this on the capture's generator: `SplatGenerator.fromSplats({ modifiers: [wind.modifier] })`. */
    modifier: SplatModifier;
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
    /** Whether anything is moving or tinting this frame (the CPU sort needs to know). */
    moving(): boolean;
    /** Once per frame. */
    tick(elapsedSeconds: number): void;
};

// The tint colours: red for included, because nothing in a daylit street scene is
// red — foliage, sky and asphalt are green/blue/grey — so "is this splat in a
// volume" is never a judgement call. The volume you're editing goes yellow instead,
// matching its wireframe.
const INCLUDED_COLOR = vec3(1.0, 0.06, 0.04);
const SELECTED_COLOR = vec3(1.0, 0.85, 0.05);

export function createWind(): Wind {
    const u = {
        // Sphere volumes: xyz = centre, w = radius; and each sphere's tree, (treeId, baseY, topY, 0).
        spheres: uniformArray(
            Array.from({ length: MAX_SPHERES }, () => new THREE.Vector4()),
            'vec4',
        ),
        groups: uniformArray(
            Array.from({ length: MAX_SPHERES }, () => new THREE.Vector4()),
            'vec4',
        ),
        count: uniform(0, 'int'),
        strength: uniform(DEFAULT_PARAMS.strength),
        speed: uniform(DEFAULT_PARAMS.speed),
        direction: uniform(THREE.MathUtils.degToRad(DEFAULT_PARAMS.direction)),
        gustiness: uniform(DEFAULT_PARAMS.gustiness),
        flutter: uniform(DEFAULT_PARAMS.flutter),
        waveTravel: uniform(DEFAULT_PARAMS.waveTravel),
        softEdge: uniform(DEFAULT_PARAMS.softEdge),
        highlight: uniform(0),
        selected: uniform(-1, 'int'),
        time: uniform(0),
    };

    /**
     * The per-splat wind: find the tree that claims this splat, sway it, and in
     * edit mode tint it. The tint tracks the sway, so the pinned base reads dark
     * and the free canopy bright — the falloff itself becomes visible.
     */
    const modifier: SplatModifier = (splat) => {
        const out = splat.toVar();
        const center = splat.get('center').toVar();

        // The sphere that claims this splat most strongly. Union by max, never a
        // sum: a splat in two overlapping trees must not be displaced twice and
        // flung out of both.
        const bestIndex = int(-1).toVar();
        const bestTree = float(0).toVar();
        const bestSway = float(0).toVar();
        const bestHeight = float(0).toVar();
        Loop({ start: int(0), end: u.count, type: 'int', condition: '<' }, ({ i }: { i: TslNode }) => {
            const sphere = u.spheres.element(i).toVar();
            const group = u.groups.element(i).toVar();
            const swayHeight = windSphereSway(center, sphere, group, u.softEdge).toVar();
            If(sphere.w.greaterThan(0).and(swayHeight.x.greaterThan(bestSway)), () => {
                bestSway.assign(swayHeight.x);
                bestHeight.assign(swayHeight.y);
                bestIndex.assign(i);
                bestTree.assign(group.x);
            });
        });

        If(bestIndex.greaterThanEqual(int(0)), () => {
            const offset = windOffset(
                u.time,
                bestTree,
                bestSway,
                bestHeight,
                u.strength,
                u.speed,
                u.direction,
                u.gustiness,
                u.flutter,
                u.waveTravel,
            );
            out.get('center').assign(center.add(offset));

            // Every volume stays strongly tinted: dimming the others to pick one out
            // just hides the thing you came to look at.
            const isSelected = bestIndex.equal(u.selected);
            const tint = select(isSelected, SELECTED_COLOR, INCLUDED_COLOR);
            const focus = select(u.selected.lessThan(int(0)).or(isSelected), float(1), float(0.75));
            const amount = u.highlight.mul(focus).mul(mix(0.55, 1.0, bestSway));
            out.get('rgb').assign(mix(splat.get('rgb'), tint, amount));
        });

        return out;
    };

    const wind: Wind = {
        modifier,
        spheres: [],
        params: { ...DEFAULT_PARAMS },
        enabled: true,
        setSpheres(next) {
            const capped = next.slice(0, MAX_SPHERES);
            wind.spheres = capped;
            const spheres = u.spheres.array as THREE.Vector4[];
            for (const sphere of spheres) sphere.set(0, 0, 0, 0);
            capped.forEach((sphere, s) => {
                spheres[s].set(sphere.center[0], sphere.center[1], sphere.center[2], sphere.radius);
            });
            packSphereGroups(capped, u.groups.array as THREE.Vector4[]);
            u.count.value = capped.length;
        },
        setParams(next) {
            const params = Object.assign(wind.params, next);
            u.strength.value = wind.enabled ? params.strength : 0;
            u.speed.value = params.speed;
            u.direction.value = THREE.MathUtils.degToRad(params.direction);
            u.gustiness.value = params.gustiness;
            u.flutter.value = params.flutter;
            u.waveTravel.value = params.waveTravel;
            u.softEdge.value = params.softEdge;
        },
        setEnabled(enabled) {
            wind.enabled = enabled;
            wind.setParams({});
        },
        setHighlight(amount) {
            u.highlight.value = THREE.MathUtils.clamp(amount, 0, 1);
        },
        setSelected(index) {
            u.selected.value = index;
        },
        moving() {
            return wind.enabled || u.highlight.value > 0;
        },
        tick(elapsedSeconds) {
            u.time.value = elapsedSeconds;
        },
    };

    wind.setSpheres(DEFAULT_SPHERES);
    return wind;
}
