import { dyno as d, type SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { REVEAL_ORIGIN } from './scene';

/**
 * A ripple of existence spreading out from one point.
 *
 * The front is a wobbling shell, not a sphere. Splats don't travel — they appear
 * where the capture put them, and the wave passing through surges them outward and
 * lets them settle, the way a ripple moves water without moving it anywhere.
 *
 * Three things make this a `GsplatModifier` rather than a `SplatEdit` sphere, which
 * would otherwise do a soft-edged fade in about fifteen lines:
 *
 *   - `gsplat.index` is a stable per-splat id, so the front can be hashed into a
 *     ragged edge instead of a clean line.
 *   - `center` is writable per splat, so each one rides the wave along ITS OWN
 *     radius. A SplatEdit displaces everything inside its SDF by the same vector.
 *   - clearing `GSPLAT_FLAG_ACTIVE` is real culling, not alpha zero: `computeSort`
 *     returns INFINITY for an inactive splat, so it is never sorted and never drawn.
 *     The effect costs least when least of it is showing.
 */

/** Metres the front travels per second. */
const SPEED = 11;
/** Metres over which a splat fades up as the front reaches it. Narrow, so it pops. */
const BAND = 1.2;
/**
 * Radius the front holds at until the first frame is actually drawn.
 *
 * Spark sorts asynchronously, and the first sort of 2.5M splats takes about 1.3
 * seconds — measured: `spark.activeSplats` is flat 0 for that long and then jumps
 * straight to 1.09M. Start the clock on load and the whole opening of the reveal
 * happens behind a blank screen. So the front waits here, with just enough active for
 * the sorter to have something to work on, and the clock starts on the frame anything
 * first appears.
 */
const SEED = 2.5;

/** Distance between wave crests, in metres. */
const WAVELENGTH = 4;
/** How far behind the front the ripple has died away, in metres. */
const DECAY = 2.5;
/** How far a crest pushes a splat along its own radius, in metres. */
const AMPLITUDE = 0.55;
/** How much a crest swells a splat, as a fraction of its size. */
const SWELL = 0.8;
/** Metres the front bulges in and out with direction, so it isn't a sphere. */
const WOBBLE = 4;
/** Metres of per-splat scatter on the front, so its edge is grainy. */
const RAGGED = 1.2;
/** Added at the crest. */
const GLOW = new THREE.Vector3(0.35, 0.42, 0.55);

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
    const uRadius = d.dynoFloat(SEED);
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
                    vec3 dir = dist > 1e-4 ? fromOrigin / dist : vec3(0.0, 1.0, 0.0);

                    // Two crossed sine lobes over direction bulge the shell in and
                    // out, and the radius in their phase makes that bulge travel, so
                    // the front is a wave passing rather than a balloon inflating...
                    float phase = ${i.radius} * 0.35;
                    float wobble = sin(dir.x * 1.7 + dir.y * 2.3 + phase) + sin(dir.z * 2.1 - dir.y * 1.1 - phase * 0.7);
                    // ...and a hash of the splat's own index grains its edge. Stable
                    // frame to frame, because the index is.
                    float grain = fract(sin(float(${g}.index) * 12.9898) * 43758.5453) - 0.5;
                    float arrival = dist + wobble * ${(WOBBLE * 0.5).toFixed(3)} + grain * ${RAGGED.toFixed(3)};

                    // Metres the front has travelled past this splat.
                    float w = ${i.radius} - arrival;
                    if (w <= 0.0) {
                        ${g}.flags = 0u;
                    } else {
                        float appear = clamp(w / ${BAND.toFixed(3)}, 0.0, 1.0);
                        appear = appear * appear * (3.0 - 2.0 * appear);
                        // A damped travelling wave. Zero at the front, so a splat
                        // arrives exactly where it belongs and is moved afterwards.
                        float ripple = sin(w * ${((Math.PI * 2) / WAVELENGTH).toFixed(5)}) * exp(-w / ${DECAY.toFixed(3)});

                        ${g}.center += dir * (${AMPLITUDE.toFixed(3)} * ripple);
                        ${g}.scales *= appear * (1.0 + ${SWELL.toFixed(3)} * ripple);
                        ${g}.rgba.rgb += vec3(${GLOW.x}, ${GLOW.y}, ${GLOW.z}) * max(ripple, 0.0);
                        ${g}.rgba.a *= appear;
                    }
                `);
            },
        });
        return { gsplat: node.outputs.gsplat };
    });

    return { time: SEED / SPEED, armed: false, running: false, radius: SEED, uRadius };
}

/** Loading has finished; the front may go as soon as there's something on screen. */
export function armReveal(reveal: Reveal): void {
    reveal.armed = true;
}

/** Run it again, without re-downloading 96MB. */
export function replayReveal(reveal: Reveal): void {
    reveal.time = SEED / SPEED;
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
