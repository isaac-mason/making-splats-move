import { type SplatModifier, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';
import windConfig from './wind.json';
import { windOffset, windSphereSway } from './wind-sway';

const { If, Loop, float, int, mix, select, uniform, uniformArray, vec3 } = TSL;

/* authored data */

export const MAX_SPHERES = 64;

export type WindSphere = {
    center: [number, number, number];
    radius: number;
    tree?: number;
};

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
    strength: number;
    speed: number;
    /** Wind heading in degrees, around Y. */
    direction: number;
    gustiness: number;
    flutter: number;
    waveTravel: number;
    softEdge: number;
};

export const DEFAULT_PARAMS: WindParams = windConfig.params;

export const DEFAULT_SPHERES: WindSphere[] = windConfig.spheres.map((sphere) => ({
    center: [sphere.center[0], sphere.center[1], sphere.center[2]],
    radius: sphere.radius,
    tree: sphere.tree,
}));

/* the wind */

export type Wind = {
    modifier: SplatModifier;
    spheres: WindSphere[];
    params: WindParams;
    setSpheres(spheres: WindSphere[]): void;
    setParams(params: Partial<WindParams>): void;
    enabled: boolean;
    setEnabled(enabled: boolean): void;
    setHighlight(amount: number): void;
    setSelected(index: number): void;
    moving(): boolean;
    tick(elapsedSeconds: number): void;
};

// Red for included: nothing in a daylit street is red. The volume being edited is yellow.
const INCLUDED_COLOR = vec3(1.0, 0.06, 0.04);
const SELECTED_COLOR = vec3(1.0, 0.85, 0.05);

export function createWind(): Wind {
    const u = {
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

    const modifier: SplatModifier = (splat) => {
        const out = splat.toVar();
        const center = splat.get('center').toVar();

        // Union by max, not sum, so a splat in two overlapping trees isn't displaced twice.
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
