import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { CURL_GLSL } from './curl';
import { type Fire, fireHeat } from './fire';
import { FLAME_ORIGIN } from './scene';

/**
 * Smoke — the layer above the flame, and the part that sells "burning" rather
 * than "glowing".
 *
 * A separate generator because it behaves almost opposite to the flame: it lives
 * far longer and rises far higher, EXPANDS rather than swelling and collapsing,
 * cools to nothing rather than glowing, and starts where the flame gives up.
 *
 * ADVECTION, not displacement. Like the flame, each puff is walked through the
 * velocity field from birth to now. Shoving a puff sideways by one noise sample is
 * a static warp, and the column reads as a wiggling rope.
 *
 * DELAYED HEAT. A puff lives ten seconds or more, so scaling it by the CURRENT
 * heat makes the whole column lurch upward together on a stoke. Instead we keep a
 * short history of the signal and each puff reads the heat at its own birth, so a
 * stoke travels up the column as a gout.
 */

export type SmokeParams = {
    /** Number of splats in the column. Recycled continuously, so this is the population. */
    count: number;
    /** Radius of the column where smoke is picked up, in world units. */
    baseRadius: number;
    /** How far above the fire the smoke takes over from the flame. */
    liftOff: number;
    /** Lifetimes per second. Much slower than the flame — smoke lingers. */
    rate: number;
    /**
     * Upward speed at handover, in world units per second, and the time constant
     * (seconds) over which buoyancy decays. There's deliberately no height: where
     * the column tops out is emergent, so a hotter fire pushes NEW smoke higher
     * without touching smoke already in the air.
     */
    riseSpeed: number;
    coolTime: number;
    /** The drift that's left once it has cooled and is just going where the air goes. */
    terminalRise: number;
    /**
     * Plume half-angle, near enough — a fraction of the rise speed pushed radially
     * outward. Turbulence can't do this: curl noise is divergence-free, so it stirs
     * a column without widening it. A real plume widens by entraining air. The
     * flame's `inflow` is the same thing with the sign flipped.
     */
    spread: number;
    /** How hard the curl field pushes a puff about, in world units per second. */
    turbulence: number;
    /** Spatial frequency of the curl field. Lower than the flame's — smoke eddies are big and slow. */
    curlScale: number;
    /** How fast the field drifts, so the column keeps churning even in still air. */
    curlScroll: number;
    /** Wind at the top of the plume, world units per second. Sheared: near nothing down among the logs. */
    wind: THREE.Vector3;
    /** How much the wind gusts, 0..1. Gusts travel up the column rather than hitting it all at once. */
    gust: number;
    /**
     * Puff radius at birth, and at death. A puff's coverage goes as size squared,
     * so the alpha tail has to fall faster than this grows or the haze turns into
     * a grey lump.
     */
    startSize: number;
    endSize: number;
    /**
     * Peak alpha PER SPLAT, and it has to stay tiny. Along a view ray n puffs give
     * 1 - (1 - a)^n: forty at a=0.035 is 0.83, a solid column. A wisp of ~0.35
     * wants a nearer 0.01.
     *
     * The floor is Spark's `minAlpha` cull (src/index.ts): go below it and puffs
     * blink out mid-life. Fewer puffs at higher alpha is the same column, further
     * above the cull.
     */
    opacity: number;
    /** Colour when it leaves the fire (still lit by it) and once it has cooled. */
    warm: THREE.Color;
    cool: THREE.Color;
};

export const DEFAULT_SMOKE: SmokeParams = {
    count: 4500,
    baseRadius: 0.16,
    liftOff: 0.55,
    rate: 0.085,
    riseSpeed: 1.3,
    coolTime: 5.0,
    terminalRise: 0.1,
    spread: 0.13,
    turbulence: 0.25,
    curlScale: 0.7,
    curlScroll: 0.12,
    wind: new THREE.Vector3(0.22, 0, -0.1),
    gust: 0.55,
    startSize: 0.05,
    endSize: 0.5,
    opacity: 0.02,
    // Darker than the dusk sky, or the column glows instead of shading it.
    warm: new THREE.Color(0.16, 0.15, 0.17),
    cool: new THREE.Color(0.1, 0.11, 0.15),
};

// Euler steps used to walk each puff from birth to now. Far more than the flame,
// because the trip is far longer: a step has to stay short next to an eddy.
const SMOKE_STEPS = 24;

// The heat history. 20s at ~0.16s resolution: long enough to outlast the slowest
// puff (see `rate`), fine enough that a stoke — which swells in over ~180ms —
// survives as a distinct gout rather than being averaged into a gentle rise.
const HISTORY_SAMPLES = 128;
const HISTORY_SPAN = 20;
const HISTORY_STEP = HISTORY_SPAN / HISTORY_SAMPLES;

const SMOKE_GLSL = /* glsl */ `
    const int SMOKE_STEPS = ${SMOKE_STEPS};

    // Heat as it was \`secondsAgo\` seconds ago. Texel 0 is now; linear filtering
    // interpolates between buckets. R8 because it's filterable everywhere and
    // plenty for driving smoke.
    float smokeHeatAt(sampler2D history, float secondsAgo) {
        float u = (secondsAgo / ${HISTORY_STEP.toFixed(6)} + 0.5) / ${HISTORY_SAMPLES}.0;
        return texture(history, vec2(clamp(u, 0.0, 1.0), 0.5)).r;
    }
`;

export type Smoke = {
    /** The generator node — add to your scene. */
    object: SplatGenerator;
    /**
     * Push this frame's fire heat in (0 = embers, 1 = roaring), with the frame's
     * dt so it can be filed in the history at a fixed rate regardless of framerate.
     */
    setHeat(heat: number, dt: number): void;
};

export function initSmoke(params: Partial<SmokeParams> = {}): Smoke {
    const p: SmokeParams = { ...DEFAULT_SMOKE, ...params };

    // The history buffer. Index 0 is the most recent bucket; pushing scrolls it
    // along, which at 128 bytes is simpler than ring-buffer arithmetic in the shader.
    const history = new Uint8Array(HISTORY_SAMPLES);
    const historyTex = new THREE.DataTexture(history, HISTORY_SAMPLES, 1, THREE.RedFormat, THREE.UnsignedByteType);
    historyTex.minFilter = THREE.LinearFilter;
    historyTex.magFilter = THREE.LinearFilter;
    historyTex.wrapS = THREE.ClampToEdgeWrapping;
    historyTex.wrapT = THREE.ClampToEdgeWrapping;
    historyTex.generateMipmaps = false;
    historyTex.needsUpdate = true;

    // Buckets are filled by time-weighted average rather than by sampling on the
    // tick, so a stoke that peaks between two pushes still leaves a mark.
    let bucketSum = 0;
    let bucketSpan = 0;
    let primed = false;

    const uOrigin = d.dynoVec3(new THREE.Vector3(FLAME_ORIGIN[0], FLAME_ORIGIN[1], FLAME_ORIGIN[2]));
    const uBaseRadius = d.dynoFloat(p.baseRadius);
    const uLiftOff = d.dynoFloat(p.liftOff);
    const uRate = d.dynoFloat(p.rate);
    const uRiseSpeed = d.dynoFloat(p.riseSpeed);
    const uCoolTime = d.dynoFloat(p.coolTime);
    const uTerminal = d.dynoFloat(p.terminalRise);
    const uSpread = d.dynoFloat(p.spread);
    const uTurbulence = d.dynoFloat(p.turbulence);
    const uCurlScale = d.dynoFloat(p.curlScale);
    const uCurlScroll = d.dynoFloat(p.curlScroll);
    const uWind = d.dynoVec3(p.wind.clone());
    const uGust = d.dynoFloat(p.gust);
    const uStartSize = d.dynoFloat(p.startSize);
    const uEndSize = d.dynoFloat(p.endSize);
    const uOpacity = d.dynoFloat(p.opacity);
    const uWarm = d.dynoVec3(new THREE.Vector3(p.warm.r, p.warm.g, p.warm.b));
    const uCool = d.dynoVec3(new THREE.Vector3(p.cool.r, p.cool.g, p.cool.b));
    const uHistory = d.dynoSampler2D(historyTex);
    const uTime = d.dynoFloat(0);

    const object = new SplatGenerator({
        numSplats: p.count,
        generator: d.dynoBlock(
            { index: 'int' },
            { gsplat: d.Gsplat },
            ({ index }) => {
                if (!index) throw new Error('smoke generator: no index input');

                const node = d.dyno({
                    inTypes: {
                        index: 'int',
                        origin: 'vec3',
                        baseRadius: 'float',
                        liftOff: 'float',
                        rate: 'float',
                        riseSpeed: 'float',
                        coolTime: 'float',
                        terminal: 'float',
                        spread: 'float',
                        turbulence: 'float',
                        curlScale: 'float',
                        curlScroll: 'float',
                        wind: 'vec3',
                        gust: 'float',
                        startSize: 'float',
                        endSize: 'float',
                        opacity: 'float',
                        warm: 'vec3',
                        cool: 'vec3',
                        history: 'sampler2D',
                        time: 'float',
                    },
                    outTypes: { gsplat: d.Gsplat },
                    inputs: {
                        index,
                        origin: uOrigin,
                        baseRadius: uBaseRadius,
                        liftOff: uLiftOff,
                        rate: uRate,
                        riseSpeed: uRiseSpeed,
                        coolTime: uCoolTime,
                        terminal: uTerminal,
                        spread: uSpread,
                        turbulence: uTurbulence,
                        curlScale: uCurlScale,
                        curlScroll: uCurlScroll,
                        wind: uWind,
                        gust: uGust,
                        startSize: uStartSize,
                        endSize: uEndSize,
                        opacity: uOpacity,
                        warm: uWarm,
                        cool: uCool,
                        history: uHistory,
                        time: uTime,
                    },
                    globals: () => [d.defineGsplat, CURL_GLSL, SMOKE_GLSL],
                    statements: ({ inputs, outputs }) => {
                        const g = outputs.gsplat;
                        const i = inputs;
                        return d.unindentLines(`
                            vec4 rand = flameHash(${i.index} * 3 + 7);
                            vec4 rand2 = flameHash(${i.index} * 3 + 8);
                            float seed = rand.w;

                            // Age sweeps 0..1 and wraps, as in the flame. Varied
                            // lifetimes give the plume a ragged top, not a ceiling.
                            float speed = ${i.rate} * (0.7 + rand.x * 0.6);
                            float age = fract(seed * 5.37 + ${i.time} * speed);
                            float elapsed = age / speed; // seconds since it left the fire

                            // How hard the fire was burning when THIS puff was made.
                            // Nothing below reads the current heat.
                            float born = smokeHeatAt(${i.history}, elapsed);

                            // Picked up on a disc where the flame is giving out. The
                            // handover height is jittered per puff, or the smoke
                            // starts on a hard flat ring floating over the fire.
                            float ang = rand.y * 6.2831853;
                            float radius = sqrt(rand.z) * ${i.baseRadius};
                            vec3 pos = ${i.origin} + vec3(
                                cos(ang) * radius,
                                ${i.liftOff} * (0.6 + 0.8 * rand2.x),
                                sin(ang) * radius
                            );

                            // ADVECTION — see the note at the top of the file.
                            float dt = elapsed / float(SMOKE_STEPS);
                            for (int k = 0; k < SMOKE_STEPS; k++) {
                                float secs = (float(k) + 0.5) * dt;

                                // Height, not age: puffs side by side must feel the
                                // same wind, or the plume shears apart and goes stringy.
                                float high = clamp((pos.y - ${i.origin}.y) / 5.0, 0.0, 1.0);

                                // Buoyancy bleeds off as the puff mixes, leaving only
                                // the drift of the air around it.
                                float rise = ${i.riseSpeed} * (0.5 + 0.9 * born)
                                           * exp(-secs / max(${i.coolTime}, 1e-3))
                                           + ${i.terminal};

                                // Entrainment: the cone. Tied to the rise speed so it
                                // opens at a roughly constant angle, with a floor so
                                // the cold top keeps spreading as it dissipates.
                                vec2 radial = pos.xz - ${i.origin}.xz;
                                float dist = length(radial);
                                vec3 outward = dist > 1e-4
                                    ? vec3(radial.x, 0.0, radial.y) / dist
                                    : vec3(0.0);
                                vec3 entrain = outward * ${i.spread} * (rise + 0.4);

                                // The flame's curl field at a lower frequency, taking
                                // over as the puff slows.
                                vec3 field = pos * ${i.curlScale}
                                           - vec3(0.0, ${i.time} * ${i.curlScroll}, 0.0);
                                // Evolves far slower than the flame's, or the long-lived
                                // column reads as boiling.
                                vec3 curl = flameCurl(field, ${i.time} * 0.12) * ${i.turbulence} * (0.2 + 1.4 * high);

                                // Wind, sheared — barely any down among the logs. The
                                // gust phase carries pos.y, so a lull travels UP the
                                // column instead of the whole plume leaning as one.
                                float gusting = 1.0 + ${i.gust} * (
                                    0.6 * sin(${i.time} * 0.21 + pos.y * 0.45)
                                  + 0.4 * sin(${i.time} * 0.37 + 1.7)
                                );
                                vec3 breeze = ${i.wind} * (0.1 + 1.2 * high) * gusting;

                                vec3 vel = vec3(0.0, rise, 0.0) + entrain + curl + breeze;
                                pos += vel * dt;
                            }

                            // Expands the whole way — it never collapses like a
                            // flame tongue does, it just spreads out and thins.
                            float size = mix(${i.startSize}, ${i.endSize}, pow(age, 0.7));

                            // Still lit by the fire on the way out, grey once cooled.
                            vec3 col = mix(${i.warm}, ${i.cool}, smoothstep(0.0, 0.4, age));

                            // In over the handover, then a long tail that falls
                            // faster than the puff expands and reaches exactly zero.
                            float alpha = smoothstep(0.0, 0.1, age) * pow(max(1.0 - age, 0.0), 2.2);
                            // A stoked fire makes MORE smoke, carried up by the puffs
                            // born in the blast.
                            alpha *= ${i.opacity} * (0.25 + 1.1 * born);

                            ${g}.center = pos;
                            ${g}.flags = GSPLAT_FLAG_ACTIVE;
                            ${g}.scales = vec3(size);
                            ${g}.index = ${i.index};
                            ${g}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
                            // Straight colour: Spark premultiplies in its own shader.
                            // Doing it here too squares alpha, leaving the puffs
                            // near-black — a dim filter tinted by whatever's behind.
                            ${g}.rgba = vec4(col, alpha);
                        `);
                    },
                });

                return { gsplat: node.outputs.gsplat };
            },
            { globals: () => [d.defineGsplat] },
        ),
        update: ({ time }) => {
            uTime.value = time;
            object.updateVersion();
        },
    });

    object.raycast = () => {};

    return {
        object,
        setHeat(heat, dt) {
            const h = THREE.MathUtils.clamp(heat, 0, 1);

            // First frame: backfill the whole history with the current level, so the
            // fire doesn't start under a column of smoke that remembers being out.
            if (!primed) {
                primed = true;
                history.fill(Math.round(h * 255));
                historyTex.needsUpdate = true;
            }

            bucketSum += h * dt;
            bucketSpan += dt;
            if (bucketSpan < HISTORY_STEP) return;

            while (bucketSpan >= HISTORY_STEP) {
                const mean = bucketSum / bucketSpan;
                history.copyWithin(1, 0, HISTORY_SAMPLES - 1);
                history[0] = Math.round(THREE.MathUtils.clamp(mean, 0, 1) * 255);
                bucketSpan -= HISTORY_STEP;
                bucketSum = mean * bucketSpan; // carry the leftover into the next bucket
            }
            historyTex.needsUpdate = true;
        },
    };
}

/** Convenience: drive the smoke straight from the shared fire signal. */
export function updateSmoke(smoke: Smoke, fire: Fire, dt: number): void {
    smoke.setHeat(fireHeat(fire), dt);
}
