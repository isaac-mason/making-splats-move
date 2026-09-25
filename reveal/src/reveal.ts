import { dyno as d, type SplatMesh } from '@sparkjsdev/spark';
import type * as THREE from 'three';

/**
 * Reveals the scene with a ripple that spreads out from one point.
 *
 * Splats outside the ripple are hidden. As the ripple reaches a splat, it fades in
 * where it belongs, bobs outward, and settles back.
 *
 * This runs on every splat, every frame, as a small shader (a Spark "modifier").
 * Hidden splats are switched off entirely rather than made transparent, so they
 * cost nothing to draw.
 */

/** The ripple takes 2 seconds to travel 110 metres, the far edge of the scene. */
const DURATION = 2;
const REACH = 110;
/** Start slow and speed up, so there's time to watch the nearby streets appear. */
const EASE = 2.2;
/**
 * The ripple waits at this radius until the first frame is on screen. Spark takes
 * about a second to get ready, and we don't want to miss the start.
 */
const SEED = 2.5;
/** The ripple never moves slower than this, in metres per second. */
const MIN_SPEED = 6;

// The shape of the wave, as GLSL constants. The *_TIME ones are in seconds: the
// shader multiplies them by the ripple's speed, so the wave looks the same size
// whether the ripple is moving slowly or quickly.
const WAVE_GLSL = d.unindent(`
    const float BAND_TIME = 0.1;   // how long a splat takes to fade in
    const float WAVE_TIME = 0.26;  // how long its bobbing takes to die away
    const float CREST_TIME = 0.38; // time between one bob and the next

    const float AMPLITUDE = 0.55;  // how far a splat bobs outward, in metres
    const float SWELL = 0.8;       // how much bigger it gets as it bobs
    const float WOBBLE = 2.0;      // how lumpy the ripple's shape is, in metres
    const float RAGGED = 1.2;      // how rough its edge is, in metres

    const vec3 GLOW = vec3(1.0, 0.72, 0.3); // gold
    const float GLOW_FOCUS = 4.0;  // higher = a thinner glowing line
    const float GLOW_GAIN = 3.0;   // how bright the glow is
`);

function rippleAt(time: number): { radius: number; speed: number } {
    const t = Math.max(time, 0) / DURATION;
    return {
        radius: REACH * t ** EASE,
        speed: Math.max(MIN_SPEED, (REACH * EASE * t ** (EASE - 1)) / DURATION),
    };
}

/** The time at which the ripple reaches `radius`. */
function timeAt(radius: number): number {
    return DURATION * (radius / REACH) ** (1 / EASE);
}

export type Reveal = {
    /** Seconds since the ripple started. */
    time: number;
    /** The scene has loaded, so the ripple can start once something is drawn. */
    armed: boolean;
    running: boolean;
    /** How far the ripple has spread, in metres. */
    radius: number;
    mesh: SplatMesh;
    uRadius: d.DynoFloat<string>;
    uSpeed: d.DynoFloat<string>;
};

export function initReveal(mesh: SplatMesh, origin: THREE.Vector3): Reveal {
    const uRadius = d.dynoFloat(SEED);
    const uSpeed = d.dynoFloat(MIN_SPEED);
    const uOrigin = d.dynoVec3(origin);

    mesh.objectModifier = d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
        if (!gsplat) throw new Error('reveal: no gsplat input');

        // a random number per splat, the same every frame, it roughens the ripple's edge.
        // uses spark's hash node, which stays random across millions of splats where the usual GLSL sin() trick starts to repeat.
        const grain = d.hashFloat(d.splitGsplat(gsplat).outputs.index);

        const node = d.dyno({
            inTypes: { gsplat: d.Gsplat, grain: 'float', radius: 'float', speed: 'float', origin: 'vec3' },
            outTypes: { gsplat: d.Gsplat },
            inputs: { gsplat, grain, radius: uRadius, speed: uSpeed, origin: uOrigin },
            globals: () => [d.defineGsplat, WAVE_GLSL],
            statements: ({ inputs: i, outputs }) => {
                const g = outputs.gsplat;
                return d.unindentLines(/* glsl */ `
                    ${g} = ${i.gsplat};

                    vec3 offset = ${g}.center - ${i.origin};
                    float dist = length(offset);
                    vec3 dir = dist > 1e-4 ? offset / dist : vec3(0.0, 1.0, 0.0);

                    // Make the ripple lumpy rather than a perfect sphere, with lumps
                    // that shift as it grows. Then add this splat's random roughness.
                    float phase = ${i.radius} * 0.35;
                    float wobble = sin(dir.x * 1.7 + dir.y * 2.3 + phase) + sin(dir.z * 2.1 - dir.y * 1.1 - phase * 0.7);
                    float arrival = dist + wobble * WOBBLE + (${i.grain} - 0.5) * RAGGED;

                    // How far the ripple has gone past this splat, in metres.
                    float w = ${i.radius} - arrival;
                    if (w <= 0.0) {
                        ${g}.flags = 0u; // not reached yet: switch it off
                    } else {
                        float appear = smoothstep(0.0, ${i.speed} * BAND_TIME, w);
                        // A bob that fades away. It starts at zero, so each splat first
                        // appears exactly where it belongs.
                        float ripple = sin(w * 6.2831853 / (${i.speed} * CREST_TIME)) * exp(-w / (${i.speed} * WAVE_TIME));
                        // Glow gold at the top and bottom of each bob.
                        float flare = pow(abs(ripple), GLOW_FOCUS) * GLOW_GAIN;

                        ${g}.center += dir * AMPLITUDE * ripple;
                        ${g}.scales *= appear * (1.0 + SWELL * ripple);
                        ${g}.rgba.rgb += GLOW * flare;
                        ${g}.rgba.a *= appear;
                    }
                `);
            },
        });
        return { gsplat: node.outputs.gsplat };
    });

    return { time: timeAt(SEED), armed: false, running: false, radius: SEED, mesh, uRadius, uSpeed };
}

/** Call when the scene has loaded. The ripple starts once something is on screen. */
export function armReveal(reveal: Reveal): void {
    reveal.armed = true;
}

/** Play the ripple again from the start. */
export function replayReveal(reveal: Reveal): void {
    reveal.time = timeAt(SEED);
}

export function updateReveal(reveal: Reveal, dt: number, drawing: boolean, frozenTime: number | null = null): void {
    if (!reveal.running) {
        if (!reveal.armed || !drawing) return;
        reveal.running = true;
    }
    if (frozenTime === null && reveal.time >= DURATION) return;
    reveal.time = frozenTime ?? Math.min(DURATION, reveal.time + dt);
    const ripple = rippleAt(reveal.time);
    if (ripple.radius === reveal.radius) return;
    reveal.radius = ripple.radius;
    reveal.uRadius.value = ripple.radius;
    reveal.uSpeed.value = ripple.speed;
    // Spark only re-runs the modifier when the mesh's version changes, so new
    // uniform values alone would sit unused until the camera next moved.
    reveal.mesh.updateVersion();
}
