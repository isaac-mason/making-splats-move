import { dyno, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

// Floating dust as REAL Gaussian splats (a generated SplatMesh) rather than a
// THREE.Points cloud. Being splats, they sort + blend together with the environment
// splats, so they occlude correctly (a mote behind a wall is hidden) and they're lit
// for free by the fire SDF light — which also makes them pulse with it.
// A GPU worldModifier drifts each mote (sway + bob); no per-frame CPU work.

const { dynoBlock, defineGsplat, unindentLines } = dyno;

const COUNT = 2500;

// World-space box the dust fills (roughly the boiler-room interior).
const BOUNDS_MIN = new THREE.Vector3(-2.3, 0.2, -4);
const BOUNDS_MAX = new THREE.Vector3(1, 2.5, 1);

const MOTE_SCALE = 0.0016; // base gaussian size (metres); jittered per mote
const BASE_OPACITY = 1; // low → the gaussian falloff shows (soft, feathered motes, not solid balls)
const BASE_COLOR = new THREE.Color(0.85, 0.7, 0.5); // warm, self-visible; the SDF adds extra glow near the fire

const SWAY = 0.06; // horizontal drift amplitude (metres)
const BOB = 0.05; // vertical drift amplitude (metres)

export type Dust = {
    /** The dust SplatMesh — add to your scene. */
    mesh: SplatMesh;
};

export function initDust(): Dust {
    // GPU drift: nudge each mote's world position by a slow per-mote sine sway/bob.
    // Phase is seeded from the mote's (original) position so each drifts independently.
    const modifier = dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
        if (!gsplat) throw new Error('dust modifier: no gsplat input');

        const node = dyno.dyno({
            inTypes: { gsplat: dyno.Gsplat, time: 'float' },
            outTypes: { gsplat: dyno.Gsplat },
            inputs: { gsplat, time: SplatMesh.dynoTime }, // dynoTime auto-updated each frame
            globals: () => [defineGsplat],
            statements: ({ inputs, outputs }) => {
                const g = outputs.gsplat;
                return unindentLines(`
                    ${g} = ${inputs.gsplat};
                    vec3 c0 = ${inputs.gsplat}.center;
                    float phase = fract(sin(dot(c0.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
                    float t = ${inputs.time};
                    ${g}.center = c0 + vec3(
                        sin(t * 0.25 + phase) * ${SWAY.toFixed(3)},
                        sin(t * 0.30 + phase) * ${BOB.toFixed(3)},
                        cos(t * 0.20 + phase) * ${SWAY.toFixed(3)}
                    );
                `);
            },
        });

        return { gsplat: node.outputs.gsplat };
    });

    const size = new THREE.Vector3().subVectors(BOUNDS_MAX, BOUNDS_MIN);
    const center = new THREE.Vector3();
    const scales = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();

    const mesh = new SplatMesh({
        maxSplats: COUNT,
        editable: true, // let the boiler SDF light tint the motes (global SplatEdits)
        worldModifier: modifier,
        constructSplats: (splats) => {
            for (let i = 0; i < COUNT; i++) {
                center.set(
                    BOUNDS_MIN.x + Math.random() * size.x,
                    BOUNDS_MIN.y + Math.random() * size.y,
                    BOUNDS_MIN.z + Math.random() * size.z,
                );
                scales.setScalar(MOTE_SCALE * (0.6 + Math.random() * 0.8)); // varied mote sizes
                const opacity = BASE_OPACITY * (0.7 + Math.random() * 0.6);
                splats.pushSplat(center, scales, quaternion, opacity, BASE_COLOR);
            }
        },
    });

    return { mesh };
}
