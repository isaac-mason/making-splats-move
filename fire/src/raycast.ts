/**
 * Ray picking against the captured splats, on the CPU, for the debug panel's
 * measuring clicks. Radix draws splats but doesn't raycast them, so this is
 * adapted from its Spark ports (examples/spark/js/raycast.ts).
 *
 * Each splat near the ray adds its Gaussian's opacity where the ray passes closest
 * to it; the hit is where the accumulated opacity first reaches `COVERAGE`, so many
 * faint splats (grass, leaves) stop the ray like one opaque one.
 */

import { type ArrayData, Splats } from 'spark-radix';
import type * as THREE from 'three';

const SIGMAS = 3;
const COVERAGE = 0.5;
const MIN_OPACITY = 0.02;

type Approach = { t: number; alpha: number };

export type SplatPicker = {
    /** The nearest hit along `ray` (world space: the scene sits at the origin), or null. */
    intersect(ray: THREE.Ray): number | null;
};

export function createSplatPicker(data: ArrayData): SplatPicker {
    const decode = Splats.decoder(Splats.get(data).bundle);
    const count = data.count;
    const splat = Splats.makeExtSplat();

    // A bounding sphere per splat, so most are skipped without decoding.
    const centers = new Float32Array(count * 3);
    const radii = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        decode(i, splat);
        centers[i * 3] = splat.center.x;
        centers[i * 3 + 1] = splat.center.y;
        centers[i * 3 + 2] = splat.center.z;
        radii[i] = splat.opacity < MIN_OPACITY ? -1 : SIGMAS * Math.max(splat.scales.x, splat.scales.y, splat.scales.z);
    }

    function closest(i: number, ray: THREE.Ray): Approach | null {
        decode(i, splat);
        const { x: qx, y: qy, z: qz, w: qw } = splat.quaternion;
        const sx = Math.max(splat.scales.x, 1e-9);
        const sy = Math.max(splat.scales.y, 1e-9);
        const sz = Math.max(splat.scales.z, 1e-9);
        // Into the splat's frame, where its Gaussian is a unit sphere.
        const { origin: o, direction: d } = ray;
        const p = rotateConjugate(o.x - centers[i * 3], o.y - centers[i * 3 + 1], o.z - centers[i * 3 + 2], qx, qy, qz, qw);
        const v = rotateConjugate(d.x, d.y, d.z, qx, qy, qz, qw);
        const px = p[0] / sx;
        const py = p[1] / sy;
        const pz = p[2] / sz;
        const vx = v[0] / sx;
        const vy = v[1] / sy;
        const vz = v[2] / sz;
        const t = -(px * vx + py * vy + pz * vz) / (vx * vx + vy * vy + vz * vz);
        const cx = px + t * vx;
        const cy = py + t * vy;
        const cz = pz + t * vz;
        const m2 = cx * cx + cy * cy + cz * cz;
        if (m2 > SIGMAS * SIGMAS) return null;
        return { t, alpha: Math.min(0.99, splat.opacity * Math.exp(-0.5 * m2)) };
    }

    return {
        intersect(ray) {
            const { origin: o, direction: d } = ray;
            const hits: Approach[] = [];
            for (let i = 0; i < count; i++) {
                const r = radii[i];
                if (r < 0) continue;
                const ox = centers[i * 3] - o.x;
                const oy = centers[i * 3 + 1] - o.y;
                const oz = centers[i * 3 + 2] - o.z;
                const along = ox * d.x + oy * d.y + oz * d.z;
                if (along + r < 0) continue;
                const px = ox - along * d.x;
                const py = oy - along * d.y;
                const pz = oz - along * d.z;
                if (px * px + py * py + pz * pz > r * r) continue;
                const hit = closest(i, ray);
                if (hit && hit.t >= 0) hits.push(hit);
            }
            if (hits.length === 0) return null;

            hits.sort((a, b) => a.t - b.t);
            let transmittance = 1;
            let best = hits[0];
            for (const hit of hits) {
                transmittance *= 1 - hit.alpha;
                if (hit.alpha > best.alpha) best = hit;
                if (1 - transmittance >= COVERAGE) return hit.t;
            }
            // A thin cloud: its most opaque point.
            return best.t;
        },
    };
}

/** v rotated by the conjugate of the unit quaternion q. */
function rotateConjugate(vx: number, vy: number, vz: number, qx: number, qy: number, qz: number, qw: number) {
    const x = -qx;
    const y = -qy;
    const z = -qz;
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    return [vx + qw * tx + (y * tz - z * ty), vy + qw * ty + (z * tx - x * tz), vz + qw * tz + (x * ty - y * tx)];
}
