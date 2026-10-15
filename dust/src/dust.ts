import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';

/**
 * Procedural dust — a field of motes generated entirely on the GPU.
 *
 * The motes are real Gaussian splats, not a THREE.Points cloud, which is the
 * whole point: they sort and blend with the environment splats, so a mote behind
 * a leaf is properly hidden instead of drawn over it. Getting that from Points
 * would mean depth-sorting them against the splat scene yourself, every frame.
 *
 * Nothing about a mote is stored anywhere. A generator is handed a splat index
 * and must return that splat, so every mote's position, size, colour and
 * brightness is *recomputed from its index* each frame — hash the index for a
 * stable random seed, then evaluate a closed-form function of (seed, time). No
 * particle buffer, no spawn/despawn bookkeeping, no CPU work proportional to the
 * mote count. Changing `DENSITY` from 1 to 100,000 costs nothing on the CPU.
 *
 * The recycling trick is worth calling out. Rather than tracking motes leaving
 * the volume and respawning them, the whole field is offset by a drift that
 * advances each frame, and the position is taken `fract()` of — so the field
 * wraps through itself forever. A mote that drifts out of the top reappears at
 * the bottom automatically, because it never really left: only the sample point
 * moved. This is the trick Spark's own `snowBox` generator uses, and it's what
 * makes an unbounded, stateless particle field possible.
 */

const { cos, distance, float, fract, hash, mix, pow, sin, smoothstep, uint, uniform, vec3, vec4 } = TSL;

export type DustParams = {
    /** Motes per cubic world unit. The mote count follows from this and the box. */
    density: number;
    /** Slowest and largest mote radius, in world units. Most land near the small end. */
    minScale: number;
    maxScale: number;
    /** How far a mote wanders from its lattice position as it turns over (world units). */
    swirl: number;
    /** How quickly the swirl turns over. */
    swirlSpeed: number;
    /** Gentle buoyant rise and fall, in world units. */
    bob: number;
    bobSpeed: number;
    /** The drift the whole field creeps along, per second. Dust settles more than it falls. */
    drift: THREE.Vector3;
    /** Base opacity of a mote before twinkle. */
    opacity: number;
    /** How much a mote dims between flashes, 0..1. 0 = steady, 1 = fully winks out. */
    twinkle: number;
    /** How brief the glint is. Higher = rarer, sharper. Low values read as a slow breath. */
    twinkleSharpness: number;
    /** Glint cycles per second, per mote. Fractions of a hertz; above ~0.2 it reads as flicker. */
    twinkleSpeed: number;
    /**
     * Motes closer to the camera than this fade out, in world units. A mote a
     * few centimetres from the lens is geometrically correct and looks like a
     * thumbprint on the screen, so the near ones are faded rather than drawn.
     */
    nearFade: number;
    /** The two colours motes are tinted between. */
    color1: THREE.Color;
    color2: THREE.Color;
};

export const DEFAULT_DUST: DustParams = {
    density: 6,
    minScale: 0.004,
    maxScale: 0.016,
    swirl: 0.32,
    swirlSpeed: 0.09,
    bob: 0.22,
    bobSpeed: 0.16,
    // Barely-there sideways creep with a slight settle: dust hangs, it doesn't fall.
    drift: new THREE.Vector3(0.012, -0.006, 0.004),
    opacity: 0.55,
    // Dust glints as a mote slowly tumbles through the light — that's a drift over
    // seconds, not a blink. 0.07 is roughly one glint every fourteen seconds per
    // mote; with tens of thousands of them at scattered phases there's always
    // something catching the light, without anything visibly flashing.
    twinkle: 0.65,
    twinkleSharpness: 2.0,
    twinkleSpeed: 0.07,
    nearFade: 1.4,
    color1: new THREE.Color(1.0, 0.96, 0.86), // warm sunlit white
    color2: new THREE.Color(0.72, 0.8, 0.95), // cool shadow blue
};

const TAU = Math.PI * 2;

/** Four hashes in [0, 1) of a splat index: xyz its cell, w its seed. */
function hashVec4(index: TslNode): TslNode {
    const base = uint(index).mul(uint(4));
    return vec4(hash(base), hash(base.add(uint(1))), hash(base.add(uint(2))), hash(base.add(uint(3))));
}

export type Dust = {
    /** The generator, as an object for the renderer's collection. */
    object: SplatObject;
    /** How many motes the field currently holds. */
    count: number;
    /** Advance the field and track the camera. Call once per frame. */
    update(time: number, dt: number, camera: THREE.Camera): void;
    /** Update any subset of the live parameters (density and box are fixed at build). */
    setParams(params: Partial<Omit<DustParams, 'density'>>): void;
};

/**
 * Build a dust field filling `box` (world-space; the generator emits world
 * coordinates directly, so the object sits at the origin).
 */
export function createDust(box: THREE.Box3, params: Partial<DustParams> = {}): Dust {
    const p: DustParams = { ...DEFAULT_DUST, ...params };

    const size = new THREE.Vector3().subVectors(box.max, box.min);
    const volume = Math.max(size.x * size.y * size.z, 1e-6);
    const count = Math.max(1, Math.min(1_000_000, Math.round(volume * p.density)));

    const uMin = uniform(box.min.clone());
    const uSize = uniform(size.clone());
    const uMinScale = uniform(p.minScale);
    const uMaxScale = uniform(p.maxScale);
    const uSwirl = uniform(p.swirl);
    const uSwirlSpeed = uniform(p.swirlSpeed);
    const uBob = uniform(p.bob);
    const uBobSpeed = uniform(p.bobSpeed);
    const uOpacity = uniform(p.opacity);
    const uTwinkle = uniform(p.twinkle);
    const uTwinkleSharp = uniform(p.twinkleSharpness);
    const uTwinkleSpeed = uniform(p.twinkleSpeed);
    const uColor1 = uniform(new THREE.Vector3(p.color1.r, p.color1.g, p.color1.b));
    const uColor2 = uniform(new THREE.Vector3(p.color2.r, p.color2.g, p.color2.b));
    const uNearFade = uniform(p.nearFade);
    // The camera's world position, so motes can fade as they approach the lens.
    const uCamera = uniform(new THREE.Vector3());
    const uTime = uniform(0);
    // Advanced on the CPU each frame — one vector for the entire field.
    const uDrift = uniform(new THREE.Vector3());

    const object = SplatCollection.object({
        count,
        generator: {
            generateSplat: (index: TslNode) => {
                // Same index, same mote, forever: xyz is its cell, w its seed.
                const random = hashVec4(index).toVar();
                const seed = random.w;
                const phase = seed.mul(TAU).toVar();

                // Lattice position in the unit cube, slid along by the field drift
                // and wrapped. fract() is the recycling: a mote leaving one face
                // re-enters the opposite one.
                const cell = fract(random.xyz.add(uDrift));
                const base = uMin.add(cell.mul(uSize)).toVar();

                // Each axis fed by a different axis of the mote's own position, so
                // neighbours turn over together in eddies rather than each jittering.
                const st = uTime.mul(uSwirlSpeed).toVar();
                const swirl = vec3(
                    sin(st.add(base.z.mul(0.9)).add(phase)),
                    sin(st.mul(0.7).add(base.x.mul(1.1)).add(phase.mul(1.3))),
                    cos(st.mul(0.85).add(base.y).add(phase.mul(0.7))),
                ).mul(uSwirl);

                // Buoyancy — dust hangs on the air rather than falling.
                const bob = sin(uTime.mul(uBobSpeed).add(phase)).mul(uBob);
                const center = base
                    .add(swirl)
                    .add(vec3(0, bob, 0))
                    .toVar();

                // Cube the distribution so most motes are near the small end: a few
                // big flecks read far better than a uniform haze of identical specks.
                const t = fract(seed.mul(97));
                const radius = mix(uMinScale, uMaxScale, t.mul(t).mul(t));

                // A fleck flashes as it tumbles, so brightness pulses sharply —
                // hence the power, rather than the sine raw.
                const wave = sin(uTime.mul(uTwinkleSpeed).mul(TAU).add(phase.mul(3.1)))
                    .mul(0.5)
                    .add(0.5);
                const glint = pow(wave, uTwinkleSharp);
                const brightness = mix(uTwinkle.oneMinus(), float(1), glint).toVar();

                // Without this the nearest motes project to enormous soft blobs —
                // geometrically correct, and ruinous.
                const near = smoothstep(uNearFade.mul(0.2), uNearFade, distance(center, uCamera));

                const rgb = mix(uColor1, uColor2, fract(seed.mul(13)));

                return GpuSplats.Splat(
                    center,
                    vec3(radius),
                    vec4(0, 0, 0, 1),
                    rgb.mul(brightness),
                    uOpacity.mul(brightness).mul(near),
                    uint(index),
                );
            },
        },
    });

    return {
        object,
        count,
        update(time, dt, camera) {
            uTime.value = time;
            camera.getWorldPosition(uCamera.value);
            // Creep the whole field. Normalised by the box size so `drift` stays in
            // world units per second whatever the box dimensions are.
            const drift: THREE.Vector3 = uDrift.value;
            drift.x += (p.drift.x / size.x) * dt;
            drift.y += (p.drift.y / size.y) * dt;
            drift.z += (p.drift.z / size.z) * dt;
        },
        setParams(next) {
            Object.assign(p, next);
            uMinScale.value = p.minScale;
            uMaxScale.value = p.maxScale;
            uSwirl.value = p.swirl;
            uSwirlSpeed.value = p.swirlSpeed;
            uBob.value = p.bob;
            uBobSpeed.value = p.bobSpeed;
            uOpacity.value = p.opacity;
            uTwinkle.value = p.twinkle;
            uTwinkleSharp.value = p.twinkleSharpness;
            uTwinkleSpeed.value = p.twinkleSpeed;
            uNearFade.value = p.nearFade;
            uColor1.value.set(p.color1.r, p.color1.g, p.color1.b);
            uColor2.value.set(p.color2.r, p.color2.g, p.color2.b);
        },
    };
}
