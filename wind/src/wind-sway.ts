/**
 * The sway kernel, as GLSL, shared by both wind paths — the dyno generator
 * modifier and the draw-time shader patch, both in src/wind.ts.
 * One copy, because two copies of the same maths drift the moment you tune one.
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
export const WIND_SWAY_GLSL = /* glsl */ `
    /**
     * How strongly one sphere claims a point, and where in its TREE that point
     * sits. sway is 0 outside the sphere.
     *
     * group is the sphere's tree: (treeId, baseY, topY, unused).
     */
    void windSphereSway(vec3 pos, vec4 sphere, vec4 group, float softEdge, out float sway, out float height) {
        float dist = distance(pos, sphere.xyz);
        if (dist > sphere.w) {
            sway = 0.0;
            height = 0.0;
            return;
        }

        // Height across the whole tree — NOT this sphere — so stacked spheres
        // agree about where the trunk is and the value stays continuous as the
        // winning sphere changes.
        float span = max(group.z - group.y, 1e-4);
        height = clamp((pos.y - group.y) / span, 0.0, 1.0);

        // Feather out near the surface so a tree has no hard spherical edge.
        float inner = sphere.w * (1.0 - softEdge);
        float edgeFade = 1.0 - smoothstep(inner, sphere.w, dist);

        // The exponent is the difference between a tree that bends and a tree
        // that looks stiff. Squaring pins so much of the lower canopy that only
        // the crown moves; 1.3 is barely super-linear, so the whole leaf mass
        // participates while the trunk still holds. (PlayCanvas uses 1.3.)
        sway = pow(height, 1.3) * edgeFade;
    }

    /** The displacement for a point, given which tree owns it and how strongly. */
    vec3 windOffset(
        float t, float treeId, float sway, float height,
        float strength, float speed, float direction,
        float gustiness, float flutter, float waveTravel
    ) {
        // Golden-ratio phase per TREE: neighbouring trees never fall into step,
        // however many there are, and every sphere of one tree shares its phase.
        float phase = fract(treeId * 0.61803) * 6.28318;
        vec2 windDir = vec2(cos(direction), sin(direction));

        // Subtracting height * waveTravel lags the canopy behind the trunk, so
        // the bend visibly travels up through the tree.
        float osc = sin(t * speed - height * waveTravel + phase);
        float gust = 1.0 + gustiness * sin(t * 0.5 + phase);
        float mag = strength * sway * gust * osc;

        // Leaf flutter. The height * 17.0 term is the important one: it
        // decorrelates neighbouring leaves VERTICALLY at high frequency, so the
        // canopy shimmers leaf-by-leaf instead of sliding as one sheet. Seeding
        // this from world XZ instead varies far too slowly to read as leaves.
        float flick = strength * flutter * sway * sin(t * speed * 3.1 + phase * 2.3 + height * 17.0);

        // Flutter is purely cross-wind and horizontal — leaves flick sideways
        // against the gust, they don't bob up and down.
        return vec3(windDir.x * mag - windDir.y * flick, 0.0, windDir.y * mag + windDir.x * flick);
    }
`;
