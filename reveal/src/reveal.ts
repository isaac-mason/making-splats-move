import { dyno as d, type SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { REVEAL_ORIGIN } from './scene';

/**
 * The city assembling itself out of one point.
 *
 * A wavefront expands from `REVEAL_ORIGIN`. Ahead of it splats don't exist; behind
 * it they sit where the capture put them; in the band between they're on their way
 * out from the origin, growing and cooling from white as they land.
 *
 * Three things make this a `GsplatModifier` rather than a `SplatEdit` sphere, which
 * would otherwise do the soft-edged fade in about fifteen lines:
 *
 *   - `gsplat.index` is a stable per-splat id, so the front can be hashed into a
 *     ragged edge instead of a clean sphere.
 *   - `center` is writable per splat, so each one travels along ITS OWN radius. A
 *     SplatEdit displaces everything inside its SDF by the same vector.
 *   - clearing `GSPLAT_FLAG_ACTIVE` is real culling, not alpha zero: `computeSort`
 *     returns INFINITY for an inactive splat, so it is never sorted and never drawn.
 *     The effect costs least when least of it is showing.
 */

/** Metres the front travels per second. */
const SPEED = 11;
/** Depth of the transition band: how long a splat spends in flight. */
const BAND = 4.5;
/** How far the ragged edge pulls a splat forward or back, in metres. */
const RAGGED = 3.5;
/**
 * Radius the front holds at until the first frame is actually drawn.
 *
 * Spark sorts asynchronously, and the first sort of 2.5M splats takes about 1.3
 * seconds — measured: `spark.activeSplats` is flat 0 for that long and then jumps
 * straight to 1.09M. Start the clock on load and the whole opening of the reveal
 * happens behind a black screen. So the front waits here, with just enough active for
 * the sorter to have something to work on, and the clock starts on the frame anything
 * first appears.
 */
const SEED = 2.5;
/** Where a splat starts, as a fraction of its final distance from the origin. */
const START = 0.12;
/** Added to the leading edge. Splats cool out of this as they land. */
const GLOW = new THREE.Vector3(0.3, 0.34, 0.52);

export type Reveal = {
    /** Seconds since the front started expanding. */
    time: number;
    /** Loading has finished; waiting on the first drawn frame. */
    armed: boolean;
    /** The front is expanding. */
    running: boolean;
    /** The front's radius, in metres. */
    radius: number;
    uRadius: ReturnType<typeof d.dynoFloat>;
};

export function initReveal(mesh: SplatMesh, origin: THREE.Vector3 | null = null): Reveal {
    const uRadius = d.dynoFloat(0);
    const uOrigin = d.dynoVec3(origin ?? new THREE.Vector3(...REVEAL_ORIGIN));

    mesh.objectModifier = d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
        if (!gsplat) throw new Error('reveal: no gsplat input');
        const node = d.dyno({
            inTypes: { gsplat: d.Gsplat, radius: 'float', origin: 'vec3' },
            outTypes: { gsplat: d.Gsplat },
            inputs: { gsplat, radius: uRadius, origin: uOrigin },
            globals: () => [d.defineGsplat],
            statements: ({ inputs, outputs }) => {
                const g = outputs.gsplat;
                const i = inputs;
                return d.unindentLines(`
                    ${g} = ${i.gsplat};

                    vec3 fromOrigin = ${g}.center - ${i.origin};
                    float dist = length(fromOrigin);

                    // Hashed off the splat's own index, so the front is ragged rather
                    // than a clean sphere — and stable frame to frame, because the
                    // index is.
                    float h = fract(sin(float(${g}.index) * 12.9898) * 43758.5453);
                    float arrival = dist + (h - 0.5) * ${RAGGED.toFixed(3)};
                    float t = clamp((${i.radius} - arrival) / ${BAND.toFixed(3)}, 0.0, 1.0);

                    if (t <= 0.0) {
                        ${g}.flags = 0u;
                    } else {
                        float ease = t * t * (3.0 - 2.0 * t);
                        vec3 start = ${i.origin} + fromOrigin * ${START.toFixed(3)};
                        ${g}.center = mix(start, ${g}.center, ease);
                        ${g}.scales *= ease;
                        // Brightest mid-flight, cooling to the capture's own colour.
                        ${g}.rgba.rgb += vec3(${GLOW.x}, ${GLOW.y}, ${GLOW.z}) * (4.0 * t * (1.0 - t));
                        ${g}.rgba.a *= ease;
                    }
                `);
            },
        });
        return { gsplat: node.outputs.gsplat };
    });

    uRadius.value = SEED;
    return { time: SEED / SPEED, armed: false, running: false, radius: SEED, uRadius };
}

/** Loading has finished; the front may go as soon as there's something on screen. */
export function armReveal(reveal: Reveal): void {
    reveal.armed = true;
}

export function updateReveal(reveal: Reveal, dt: number, drawing: boolean, frozenTime: number | null = null): void {
    if (!reveal.running) {
        if (!reveal.armed || !drawing) return;
        reveal.running = true;
    }
    reveal.time = frozenTime ?? reveal.time + dt;
    reveal.radius = reveal.time * SPEED;
    reveal.uRadius.value = reveal.radius;
}
