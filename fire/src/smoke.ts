import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { CURL_GLSL } from './curl';
import { type Fire, fireHeat } from './fire';
import { FLAME_ORIGIN } from './scene';

/**
 * Smoke — the layer above the flame.
 *
 * Production fire VFX is never one emitter: it's a core flame, an outer flame,
 * embers and smoke, each with its own lifetime, size and noise. Smoke is the one
 * that sells "this is burning" rather than "this is glowing", because it's the
 * part that persists after the fire has finished with it.
 *
 * It behaves almost opposite to the flame, which is why it's a separate generator
 * rather than more parameters on that one:
 *
 *   - it lives many times longer, and rises far higher
 *   - it EXPANDS over its life instead of swelling then collapsing
 *   - it cools to nothing rather than glowing
 *   - it starts where the flame is giving up, not at the fuel
 *
 * Two things make the difference between a plume and a ribbon taped to the fire,
 * and both are consequences of smoke being SLOW:
 *
 * ADVECTION, not displacement. Like the flame (src/flame.ts) each puff is walked
 * through the velocity field from birth to now in Euler steps, rather than placed
 * on a curve and then shoved sideways by one noise sample. Displacing by a field
 * is a static warp: the puff sits on a fixed path, so the column reads as a rope
 * that wiggles rather than a gas that rolls over itself. Smoke needs many more
 * steps than the flame because it lives ~30x longer — a step has to stay short
 * next to the eddies it's travelling through.
 *
 * DELAYED HEAT. Everything else in this app reads the fire signal for THIS
 * frame (see src/fire.ts), which is right when the thing you're driving lives
 * for a fraction of a second. A puff of smoke lives ten seconds or more, and
 * multiplying its height by the current heat re-scales the whole column at once:
 * stoke the fire and every puff in the sky lurches upward together, which is the
 * single most artificial thing smoke can do. What a puff actually carries is the
 * heat of the fire AT THE MOMENT IT LEFT IT, so we keep a short history of the
 * signal and each puff looks up its own birth time in it. A stoke then travels
 * up the column as a denser, faster gout — which is what you were trying to draw
 * in the first place.
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
     * (seconds) over which buoyancy decays as the puff mixes with cold air.
     *
     * Note what ISN'T here: a height. Where the column tops out is emergent — the
     * integral of a decaying rise speed over a lifetime — which is what lets a
     * hotter fire push its smoke higher without touching smoke that has already
     * left. A `height` parameter can only ever be applied to every puff at once.
     */
    riseSpeed: number;
    coolTime: number;
    /** The drift that's left once it has cooled and is just going where the air goes. */
    terminalRise: number;
    /**
     * Plume half-angle, near enough — a fraction of the rise speed pushed radially
     * outward.
     *
     * This is the part that's easy to leave out, because it looks like turbulence
     * should do it. It can't: curl noise is divergence-free, so it stirs a plume
     * without expanding it, and a stirred pencil-thin column is still a
     * pencil-thin column. A real plume widens because it ENTRAINS — it drags cold
     * air in across its whole surface and grows a cone, roughly 10-15 degrees.
     * The flame does the same thing with the sign flipped (see `inflow`): fire
     * necks inward, its smoke opens outward.
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
     * Puff radius at birth, and at death. Smoke expands as it cools and mixes.
     *
     * Expansion is why smoke is so easy to get wrong. A puff's contribution to
     * what you see goes as roughly size squared, so growing one tenfold makes it a
     * hundred times denser unless its alpha drops to match — which is how a thin
     * haze turns into a solid grey lump parked over the fire. The long alpha tail
     * below is doing that job.
     */
    startSize: number;
    endSize: number;
    /**
     * Peak alpha PER SPLAT, and it has to stay tiny — far smaller than the opacity
     * you actually want to see.
     *
     * What you see is the accumulation along a view ray: with n overlapping puffs
     * the total is 1 - (1 - a)^n. Forty puffs at a=0.035 comes out at 0.83 — a
     * solid black column, not a haze. Solve it the other way: for a wisp reading
     * about 0.35, a is nearer 0.01.
     *
     * But there's a floor, and it isn't the one you'd guess. Spark culls a splat
     * entirely once its alpha falls under `minAlpha` (see the SparkRenderer set-up
     * in src/index.ts), so drive this too low and the dispersal tail below never
     * renders — puffs simply blink out mid-life. Since what matters is `count`
     * TIMES this, the fix is to trade population for per-splat alpha: half as many
     * puffs at twice the opacity is the same column, twice as far above the cull,
     * and half the sorting work.
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
    opacity: 0.0125,
    warm: new THREE.Color(0.42, 0.36, 0.31),
    cool: new THREE.Color(0.58, 0.59, 0.64),
};

// Euler steps used to walk each puff from birth to now. Far more than the flame's
// four, because the trip is ~30x longer in seconds: what matters is the distance
// covered per step against the size of an eddy, not the step count itself.
const SMOKE_STEPS = 24;

// The heat history. 20s at ~0.16s resolution: long enough to outlast the slowest
// puff (see `rate`), fine enough that a stoke — which swells in over ~180ms —
// survives as a distinct gout rather than being averaged into a gentle rise.
const HISTORY_SAMPLES = 128;
const HISTORY_SPAN = 20;
const HISTORY_STEP = HISTORY_SPAN / HISTORY_SAMPLES;

const SMOKE_GLSL = /* glsl */ `
    const int SMOKE_STEPS = ${SMOKE_STEPS};

    // Heat as it was \`secondsAgo\` seconds ago. Texel 0 is now and the buffer
    // scrolls, so this is a plain 1D lookup — and because the texture filters
    // linearly the GPU interpolates between buckets for free.
    //
    // 8 bits is plenty: this is driving how thick and how fast a puff of smoke is,
    // not a depth buffer, and R8 is filterable on every GL2 target whereas float
    // textures are not.
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

    // The history buffer. Index 0 is the most recent bucket; pushing scrolls the
    // whole thing one place along, which at 128 bytes is far cheaper than the
    // read-side cursor arithmetic a ring buffer would need in the shader.
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

                            // Age sweeps 0..1 and wraps, same stateless trick as the
                            // flame — just far slower. Lifetimes vary per puff, which
                            // is most of why the top of the plume is a ragged front
                            // rather than a ceiling.
                            float speed = ${i.rate} * (0.7 + rand.x * 0.6);
                            float age = fract(seed * 5.37 + ${i.time} * speed);
                            float elapsed = age / speed; // seconds since it left the fire

                            // How hard the fire was burning when THIS puff was made.
                            // Everything a puff carries away from the fire is fixed
                            // at this moment; nothing below reads the current heat.
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

                            // ADVECTION. Walk it through the velocity field from
                            // birth to now. See the note at the top of the file: a
                            // single noise sample used as a displacement is a static
                            // warp, and a static warp is what makes smoke look like a
                            // rope hanging off the fire.
                            float dt = elapsed / float(SMOKE_STEPS);
                            for (int k = 0; k < SMOKE_STEPS; k++) {
                                float secs = (float(k) + 0.5) * dt;

                                // Height above the fire, not age: two puffs side by
                                // side must feel the same wind and the same eddies
                                // even if one is older than the other. Anything keyed
                                // to age shears them apart and the plume goes stringy.
                                float high = clamp((pos.y - ${i.origin}.y) / 5.0, 0.0, 1.0);

                                // Buoyancy bleeds off exponentially as the puff mixes
                                // with cold air, leaving only the drift of the air
                                // it's now part of. A hot fire launches its smoke
                                // faster; it does not speed up smoke already gone.
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

                                // Same curl field the flame rides, at a lower
                                // frequency — smoke eddies are big and slow. It has
                                // little grip in the hot fast gas near the fire and
                                // takes over as the puff slows down.
                                vec3 field = pos * ${i.curlScale}
                                           - vec3(0.0, ${i.time} * ${i.curlScroll}, 0.0);
                                // Evolves far more slowly than the flame's: a puff lives ten
                                // seconds, so eddies that turned over on the flame's
                                // clock would read as the whole column boiling.
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

                            // In over the handover, then a long tail as it disperses.
                            // The power curve matters: it has to fall faster than the
                            // puff expands, or the column thickens into a lump as it
                            // climbs instead of thinning out. It also has to reach
                            // exactly zero, or the smoke ends in a hard-edged cloud
                            // hanging in the air.
                            float alpha = smoothstep(0.0, 0.1, age) * pow(max(1.0 - age, 0.0), 2.2);
                            // Birth heat again: a stoked fire makes MORE smoke, and
                            // that extra density rides up the column with the puffs
                            // that were born in the blast.
                            alpha *= ${i.opacity} * (0.25 + 1.1 * born);

                            ${g}.center = pos;
                            ${g}.flags = GSPLAT_FLAG_ACTIVE;
                            ${g}.scales = vec3(size);
                            ${g}.index = ${i.index};
                            ${g}.quaternion = vec4(0.0, 0.0, 0.0, 1.0);
                            // PREMULTIPLIED, unlike the flame and embers — and this
                            // is the whole difference between smoke and glow.
                            //
                            // Spark blends premultiplied, so writing a straight
                            // colour at low alpha adds light instead of covering
                            // what's behind it. That's exactly what fire wants, and
                            // exactly what smoke must not do: additive smoke can only
                            // ever brighten, so it glows, and it picks up the hue of
                            // whatever it's drifting across — over a dark treeline it
                            // goes green. Multiplying the colour through by alpha
                            // gives ordinary compositing, so it occludes and keeps
                            // its own grey.
                            ${g}.rgba = vec4(col * alpha, alpha);
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
