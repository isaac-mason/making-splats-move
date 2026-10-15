/**
 * The sway kernel, as TSL. One copy, shared by the modifier in src/wind.ts and
 * anything else that wants to ask "how would the wind move this point".
 *
 * The model is ported from PlayCanvas's GsplatTrees (playcanvas/engine#9022),
 * which is the best-looking splat wind going. Each authored sphere marks canopy:
 * the BASE of the tree it belongs to is where the trunk is anchored, and sway
 * grows with height above it.
 *
 * A splat takes its sway from whichever sphere claims it most strongly, never the
 * sum — summing would displace a splat in two spheres twice and fling it out of
 * both. Which makes TREE GROUPING load-bearing: a tall tree usually wants several
 * stacked spheres, and if each carried its own phase and its own base height,
 * splats either side of the crossover would swing out of step and shear the canopy
 * in half. Spheres sharing a tree id share one phase and one base, so stacking is
 * just a way to describe a shape, not a way to cut a tree in two.
 */

import { TSL, type TslNode } from 'spark-radix';

const { Fn, clamp, cos, distance, fract, max, pow, sin, smoothstep, step, vec2, vec3 } = TSL;

/**
 * How strongly one sphere claims a point (x), and where in its TREE that point
 * sits (y). sway is 0 outside the sphere.
 *
 * group is the sphere's tree: (treeId, baseY, topY, unused).
 */
export const windSphereSway = Fn(([pos, sphere, group, softEdge]: TslNode[]) => {
    const dist = distance(pos, sphere.xyz).toVar();
    const inside = step(dist, sphere.w);

    // Height across the whole tree — NOT this sphere — so stacked spheres agree
    // about where the trunk is and the value stays continuous as the winning
    // sphere changes.
    const span = max(group.z.sub(group.y), 1e-4);
    const height = clamp(pos.y.sub(group.y).div(span), 0, 1).toVar();

    // Feather out near the surface so a tree has no hard spherical edge.
    const inner = sphere.w.mul(softEdge.oneMinus());
    const edgeFade = smoothstep(inner, sphere.w, dist).oneMinus();

    // The exponent is the difference between a tree that bends and a tree that
    // looks stiff. Squaring pins so much of the lower canopy that only the crown
    // moves; 1.3 is barely super-linear, so the whole leaf mass participates while
    // the trunk still holds. (PlayCanvas uses 1.3.)
    return vec2(pow(height, 1.3).mul(edgeFade).mul(inside), height.mul(inside));
}).setLayout({
    name: 'windSphereSway',
    type: 'vec2',
    inputs: [
        { name: 'pos', type: 'vec3' },
        { name: 'sphere', type: 'vec4' },
        { name: 'group', type: 'vec4' },
        { name: 'softEdge', type: 'float' },
    ],
});

/** The displacement for a point, given which tree owns it and how strongly. */
export const windOffset = Fn(
    ([t, treeId, sway, height, strength, speed, direction, gustiness, flutter, waveTravel]: TslNode[]) => {
        // Golden-ratio phase per TREE: neighbouring trees never fall into step,
        // however many there are, and every sphere of one tree shares its phase.
        const phase = fract(treeId.mul(0.61803)).mul(6.28318).toVar();
        const windDir = vec2(cos(direction), sin(direction)).toVar();

        // Subtracting height * waveTravel lags the canopy behind the trunk, so the
        // bend visibly travels up through the tree.
        const osc = sin(t.mul(speed).sub(height.mul(waveTravel)).add(phase));
        const gust = gustiness.mul(sin(t.mul(0.5).add(phase))).add(1);
        const mag = strength.mul(sway).mul(gust).mul(osc).toVar();

        // Leaf flutter. The height * 17.0 term is the important one: it decorrelates
        // neighbouring leaves VERTICALLY at high frequency, so the canopy shimmers
        // leaf-by-leaf instead of sliding as one sheet.
        const flick = strength
            .mul(flutter)
            .mul(sway)
            .mul(sin(t.mul(speed).mul(3.1).add(phase.mul(2.3)).add(height.mul(17))))
            .toVar();

        // Flutter is purely cross-wind and horizontal — leaves flick sideways
        // against the gust, they don't bob up and down.
        return vec3(windDir.x.mul(mag).sub(windDir.y.mul(flick)), 0, windDir.y.mul(mag).add(windDir.x.mul(flick)));
    },
).setLayout({
    name: 'windOffset',
    type: 'vec3',
    inputs: [
        { name: 't', type: 'float' },
        { name: 'treeId', type: 'float' },
        { name: 'sway', type: 'float' },
        { name: 'height', type: 'float' },
        { name: 'strength', type: 'float' },
        { name: 'speed', type: 'float' },
        { name: 'direction', type: 'float' },
        { name: 'gustiness', type: 'float' },
        { name: 'flutter', type: 'float' },
        { name: 'waveTravel', type: 'float' },
    ],
});
