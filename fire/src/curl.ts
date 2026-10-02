/**
 * Shared GLSL for the fire's particle generators — the flame and the smoke both
 * ride the same curl field, so they churn together instead of looking like two
 * unrelated effects stacked on top of each other.
 *
 * Spark de-duplicates globals by exact string, so including this in several
 * generators costs nothing.
 */
export const CURL_GLSL = /* glsl */ `
    // Divergence-free curl noise. The curl of a SINE potential is analytic, so a
    // few cosines give an exact field instead of six noise samples for finite
    // differences. Divergence-free means particles swirl past each other rather
    // than piling up or thinning out.
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

    // The time argument EVOLVES the field rather than sliding it past: each
    // octave's phase advances at its own rate, faster for the finer one, so small
    // eddies form and break up while large ones hold. Still exactly divergence-free
    // at every instant. Callers pass an already-scaled time.
    vec3 flameCurl(vec3 p, float t) {
        // Scaled to roughly unit magnitude, so \`turbulence\` is in world units.
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
