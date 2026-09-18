/**
 * Shared GLSL for the fire's particle generators — the flame and the smoke both
 * ride the same curl field, so they churn together instead of looking like two
 * unrelated effects stacked on top of each other.
 *
 * Spark de-duplicates globals by exact string, so including this in several
 * generators costs nothing.
 */
export const CURL_GLSL = /* glsl */ `
    // Divergence-free curl noise, the standard tool for advecting fire particles.
    //
    // Normally you'd build a noise potential and take its curl by finite
    // differences — six noise samples per particle. But the curl of a SINE
    // potential is analytic, so a handful of cosines gives an exact,
    // divergence-free field for a fraction of the cost. Divergence-free is the
    // property that matters: particles swirl past each other instead of piling up
    // in sinks or thinning out of sources.
    //
    // Crucially this is sampled at the particle's POSITION, so two particles that
    // are near each other move together no matter which tongue they belong to.
    // That's what makes flame read as a continuous medium being stirred, rather
    // than a bundle of ropes each waving on its own clock.
    vec3 flameCurlOctave(vec3 p, vec3 phase) {
        vec3 k1 = vec3( 1.7,  1.1, -1.3);
        vec3 k2 = vec3(-1.2,  1.9,  1.5);
        vec3 k3 = vec3( 1.4, -1.6,  1.8);
        float c1 = cos(dot(k1, p) + phase.x);
        float c2 = cos(dot(k2, p) + phase.y);
        float c3 = cos(dot(k3, p) + phase.z);
        return vec3(
            k3.y * c3 - k2.z * c2,
            k1.z * c1 - k3.x * c3,
            k2.x * c2 - k1.y * c1
        );
    }

    // The time argument EVOLVES the field, as opposed to sliding it past you.
    //
    // A frozen pattern translating through the scene is the standard cheap trick,
    // and it's why procedural fire so often looks like a shape being deformed
    // rather than gas flowing: the eddies never change, they only move. Real ones
    // form, stretch and break up, and they do it faster the smaller they are —
    // turnover time goes as roughly L^(2/3) — so the fine structure has to flicker
    // while the large structure holds. Advancing each wave's phase does that, at
    // its own rate per octave.
    //
    // It's free, and it costs nothing in correctness either: t is a parameter,
    // not a coordinate, so at every instant this is still exactly the curl of a
    // sine potential, and therefore still divergence-free. Callers pass an
    // already-scaled time, so each effect picks its own turnover speed.
    vec3 flameCurl(vec3 p, float t) {
        // Scaled to roughly unit magnitude. The raw curl carries the wave-vector
        // lengths (~2-3 per octave), so without this the turbulence parameter is
        // in mystery units and any sane-looking value flings particles clean out
        // of the flame.
        return (flameCurlOctave(p, vec3(1.13, -0.87, 1.51) * t)
              + 0.5 * flameCurlOctave(p * 2.63 + 11.3, vec3(-2.9, 3.7, 3.1) * t)) * 0.26;
    }

    // Shortest-arc rotation taking +Y onto dir, as an xyzw quaternion.
    vec4 flameAlignY(vec3 dir) {
        vec3 axis = cross(vec3(0.0, 1.0, 0.0), dir);
        float w = 1.0 + dir.y;
        return normalize(vec4(axis, w));
    }

    vec4 flameHash(int i) {
        vec3 p = fract(vec3(float(i)) * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yzx + 33.33);
        vec3 a = fract((p.xxy + p.yzz) * p.zyx);
        float w = fract(sin(float(i) * 78.233) * 43758.5453);
        return vec4(a, w);
    }
`;
