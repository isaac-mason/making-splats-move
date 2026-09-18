import { dyno as d, SplatGenerator } from '@sparkjsdev/spark';
import * as THREE from 'three';

/**
 * Procedural dust — a field of motes generated entirely on the GPU.
 *
 * The motes are real Gaussian splats, not a THREE.Points cloud, which is the
 * whole point: they sort and blend with the environment splats, so a mote behind
 * a leaf is properly hidden instead of drawn over it. Getting that from Points
 * would mean depth-sorting them against the splat scene yourself, every frame.
 *
 * Nothing about a mote is stored anywhere. A `SplatGenerator` is handed a splat
 * index and must return that splat, so every mote's position, size, colour and
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

/** Shorthand for the literal floats the graph is full of. */
const f = (value: number) => d.dynoConst('float', value);
const TAU = f(Math.PI * 2);

export type Dust = {
    /** The generator node — add this to your scene. */
    object: SplatGenerator;
    /** How many motes the field currently holds. */
    count: number;
    /** Update any subset of the live parameters (density and box are fixed at build). */
    setParams(params: Partial<Omit<DustParams, 'density'>>): void;
};

/**
 * Build a dust field filling `box` (world-space; the generator emits world
 * coordinates directly, so don't transform the returned object).
 */
export function createDust(box: THREE.Box3, params: Partial<DustParams> = {}): Dust {
    const p: DustParams = { ...DEFAULT_DUST, ...params };

    const size = new THREE.Vector3().subVectors(box.max, box.min);
    const volume = Math.max(size.x * size.y * size.z, 1e-6);
    const count = Math.max(1, Math.min(1_000_000, Math.round(volume * p.density)));

    const uMin = d.dynoVec3(box.min.clone());
    const uSize = d.dynoVec3(size.clone());
    const uMinScale = d.dynoFloat(p.minScale);
    const uMaxScale = d.dynoFloat(p.maxScale);
    const uSwirl = d.dynoFloat(p.swirl);
    const uSwirlSpeed = d.dynoFloat(p.swirlSpeed);
    const uBob = d.dynoFloat(p.bob);
    const uBobSpeed = d.dynoFloat(p.bobSpeed);
    const uOpacity = d.dynoFloat(p.opacity);
    const uTwinkle = d.dynoFloat(p.twinkle);
    const uTwinkleSharp = d.dynoFloat(p.twinkleSharpness);
    const uTwinkleSpeed = d.dynoFloat(p.twinkleSpeed);
    const uColor1 = d.dynoVec3(new THREE.Vector3(p.color1.r, p.color1.g, p.color1.b));
    const uColor2 = d.dynoVec3(new THREE.Vector3(p.color2.r, p.color2.g, p.color2.b));
    const uNearFade = d.dynoFloat(p.nearFade);
    // The camera's world position, so motes can fade as they approach the lens.
    const uCamera = d.dynoVec3(new THREE.Vector3());
    const uTime = d.dynoFloat(0);
    // Advanced on the CPU each frame — one vector for the entire field.
    const uDrift = d.dynoVec3(new THREE.Vector3(0, 0, 0));

    const object = new SplatGenerator({
        numSplats: count,
        generator: d.dynoBlock(
            { index: 'int' },
            { gsplat: d.Gsplat },
            ({ index }) => {
                if (!index) throw new Error('dust generator: no index input');

                // One stable hash per mote: xyz is its lattice cell, w its seed.
                // Same index, same mote, forever — which is what makes the field
                // stateless.
                const random = d.hashVec4(index);
                const seed = d.split(random).outputs.w;
                const phase = d.mul(seed, TAU);

                // Lattice position in the unit cube, slid along by the field drift
                // and wrapped. fract() is the recycling: a mote leaving one face
                // re-enters the opposite one.
                const cell = d.fract(d.add(d.vec3(random), uDrift));
                const base = d.add(uMin, d.mul(cell, uSize));
                const { x: baseX, y: baseY, z: baseZ } = d.split(base).outputs;

                // Swirl: three sines at different rates, each fed by a different
                // axis of the mote's own position, so neighbours turn over together
                // in slow eddies rather than each jittering on its own.
                const st = d.mul(uTime, uSwirlSpeed);
                const swirl = d.mul(
                    d.combine({
                        vectorType: 'vec3',
                        x: d.sin(d.add(d.add(d.mul(st, f(1.0)), d.mul(baseZ, f(0.9))), phase)),
                        y: d.sin(d.add(d.add(d.mul(st, f(0.7)), d.mul(baseX, f(1.1))), d.mul(phase, f(1.3)))),
                        z: d.cos(d.add(d.add(d.mul(st, f(0.85)), d.mul(baseY, f(1.0))), d.mul(phase, f(0.7)))),
                    }),
                    uSwirl,
                );

                // Buoyancy — dust hangs on the air rather than falling.
                const bob = d.mul(d.sin(d.add(d.mul(uTime, uBobSpeed), phase)), uBob);
                const center = d.add(d.add(base, swirl), d.combine({ vectorType: 'vec3', y: bob }));

                // Cube the distribution so most motes are near the small end: a few
                // big flecks read far better than a uniform haze of identical specks.
                const t = d.fract(d.mul(seed, f(97.0)));
                const radius = d.mix(uMinScale, uMaxScale, d.mul(d.mul(t, t), t));

                // Twinkle. A real mote is an irregular fleck that flashes as it
                // tumbles through the light, so brightness pulses sharply rather
                // than fading evenly — hence the power, rather than the sine raw.
                const wave = d.add(
                    f(0.5),
                    d.mul(f(0.5), d.sin(d.add(d.mul(d.mul(uTime, uTwinkleSpeed), TAU), d.mul(phase, f(3.1))))),
                );
                const glint = d.pow(wave, uTwinkleSharp);
                const brightness = d.mix(d.sub(f(1.0), uTwinkle), f(1.0), glint);

                // Fade motes out as they approach the lens. Without this the few
                // nearest the camera project to enormous soft blobs across the
                // frame — geometrically correct, and ruinous.
                const near = d.smoothstep(d.mul(uNearFade, f(0.2)), uNearFade, d.distance(center, uCamera));

                const rgb = d.mix(uColor1, uColor2, d.fract(d.mul(seed, f(13.0))));

                return {
                    gsplat: d.combineGsplat({
                        flags: d.dynoLiteral('uint', 'GSPLAT_FLAG_ACTIVE'),
                        index,
                        center,
                        scales: d.vec3(radius),
                        quaternion: d.dynoConst('vec4', new THREE.Quaternion(0, 0, 0, 1)),
                        rgb: d.mul(rgb, brightness),
                        opacity: d.mul(d.mul(uOpacity, brightness), near),
                    }),
                };
            },
            { globals: () => [d.defineGsplat] },
        ),
        update: ({ time, deltaTime, viewToWorld }) => {
            uTime.value = time;
            // viewToWorld's translation is the camera's world position.
            uCamera.value.setFromMatrixPosition(viewToWorld);
            // Creep the whole field. Normalised by the box size so `drift` stays in
            // world units per second whatever the box dimensions are.
            uDrift.value.x += (p.drift.x / size.x) * deltaTime;
            uDrift.value.y += (p.drift.y / size.y) * deltaTime;
            uDrift.value.z += (p.drift.z / size.z) * deltaTime;
            // Same contract as any animated Spark geometry: the generator only
            // re-runs when its version changes, so bump it or the dust freezes
            // the moment the camera stops moving.
            object.updateVersion();
        },
    });

    return {
        object,
        count,
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
