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

/**
 * Seconds for the front to cross the entire capture.
 */
const DURATION = 2;
/**
 * Metres from the origin to the far side of the world.
 *
 * Measured by stepping the front and watching `spark.activeSplats` saturate: 1.23M
 * splats are within 10m, 1.61M within 30m, and it stops climbing at 1.91M by 110m.
 */
const REACH = 110;
/**
 * Curve on the radius. Above 1 the front ACCELERATES, which is what makes a
 * two-second reveal watchable: the distribution above is brutally front-loaded, so a
 * constant speed spends a tenth of a second on the street you're looking at and the
 * rest of the time on distant background. This gives the first second to the near
 * scene and lets the far half whip past.
 */
const EASE = 2.2;

/**
 * The ripple, in SECONDS rather than metres.
 *
 * What makes it legible is how long a splat spends inside the wave, not how many
 * metres long the wave is — and with an accelerating front those are no longer the
 * same thing. The shader derives the spatial sizes from the front's current speed,
 * so the ripple looks identical at 8 m/s and at 120 m/s.
 */
const BAND_TIME = 0.1;
const WAVE_TIME = 0.26;
const CREST_TIME = 0.38;
/** Floor on the front's speed, so the wave can't collapse to nothing at t = 0. */
const MIN_SPEED = 6;

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

/** How far a crest pushes a splat along its own radius, in metres. */
const AMPLITUDE = 0.55;
/** How much a crest swells a splat, as a fraction of its size. */
const SWELL = 0.8;
/** Metres the front bulges in and out with direction, so it isn't a sphere. */
const WOBBLE = 4;
/** Metres of per-splat scatter on the front, so its edge is grainy. */
const RAGGED = 1.2;
/** Gold at the crest, and how hard it flares. */
const GLOW = new THREE.Vector3(1.0, 0.72, 0.3);
/**
 * Power on the wave before it lights: high makes the crest a thin bright line
 * rather than a broad wash. Spark's own ripple demo uses `pow(abs(wave), 3.)`.
 */
const GLOW_FOCUS = 4;
const GLOW_GAIN = 3;

/** Where the front is at `time`, and how fast it's moving there. */
function frontAt(time: number): { radius: number; speed: number } {
    const t = Math.max(time, 0) / DURATION;
    const radius = REACH * t ** EASE;
    const speed = Math.max(MIN_SPEED, (REACH * EASE * t ** (EASE - 1)) / DURATION);
    return { radius, speed };
}

/** The time at which the front is `radius` — the inverse of the curve above. */
function timeAt(radius: number): number {
    return DURATION * (radius / REACH) ** (1 / EASE);
}

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
    uSpeed: ReturnType<typeof d.dynoFloat>;
};

export function initReveal(mesh: SplatMesh, origin: THREE.Vector3 | null = null): Reveal {
    const uRadius = d.dynoFloat(SEED);
    const uSpeed = d.dynoFloat(MIN_SPEED);
    const uOrigin = d.dynoVec3(origin ?? new THREE.Vector3(...REVEAL_ORIGIN));

    mesh.objectModifier = d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
        if (!gsplat) throw new Error('reveal: no gsplat input');
        const node = d.dyno({
            inTypes: { gsplat: d.Gsplat, radius: 'float', speed: 'float', origin: 'vec3' },
            outTypes: { gsplat: d.Gsplat },
            inputs: { gsplat, radius: uRadius, speed: uSpeed, origin: uOrigin },
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
                        // The wave's spatial size follows the front's current speed,
                        // so a splat always spends the same TIME inside it.
                        float band = ${i.speed} * ${BAND_TIME.toFixed(3)};
                        float decay = ${i.speed} * ${WAVE_TIME.toFixed(3)};
                        float crest = ${i.speed} * ${CREST_TIME.toFixed(3)};

                        float appear = clamp(w / band, 0.0, 1.0);
                        appear = appear * appear * (3.0 - 2.0 * appear);
                        // A damped travelling wave. Zero at the front, so a splat
                        // arrives exactly where it belongs and is moved afterwards.
                        float ripple = sin(w * 6.2831853 / crest) * exp(-w / decay);

                        ${g}.center += dir * (${AMPLITUDE.toFixed(3)} * ripple);
                        ${g}.scales *= appear * (1.0 + ${SWELL.toFixed(3)} * ripple);
                        // abs(), so it flares on the trough as well as the crest —
                        // two pulses a wavelength, which is what reads as pulsing.
                        float flare = pow(abs(ripple), ${GLOW_FOCUS.toFixed(1)}) * ${GLOW_GAIN.toFixed(2)};
                        ${g}.rgba.rgb += vec3(${GLOW.x}, ${GLOW.y}, ${GLOW.z}) * flare;
                        ${g}.rgba.a *= appear;
                    }
                `);
            },
        });
        return { gsplat: node.outputs.gsplat };
    });

    return { time: timeAt(SEED), armed: false, running: false, radius: SEED, uRadius, uSpeed };
}

/** Loading has finished; the front may go as soon as there's something on screen. */
export function armReveal(reveal: Reveal): void {
    reveal.armed = true;
}

/** Run it again, without re-downloading 96MB. */
export function replayReveal(reveal: Reveal): void {
    reveal.time = timeAt(SEED);
}

export function updateReveal(reveal: Reveal, dt: number, drawing: boolean, frozenTime: number | null = null): void {
    if (!reveal.running) {
        if (!reveal.armed || !drawing) return;
        reveal.running = true;
    }
    // Stop once the front is past everything, or the uniform keeps changing and Spark
    // keeps re-sorting a scene that has finished moving.
    if (frozenTime === null && reveal.time >= DURATION) return;
    reveal.time = frozenTime ?? Math.min(DURATION, reveal.time + dt);
    const front = frontAt(reveal.time);
    reveal.radius = front.radius;
    reveal.uRadius.value = front.radius;
    reveal.uSpeed.value = front.speed;
}
