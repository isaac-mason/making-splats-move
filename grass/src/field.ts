/**
 * The meadow: a ground of flat splats and a quarter of a million grass blades, all
 * generated on the GPU from nothing but the splat index and the time. Nothing is
 * stored, so the wind costs nothing extra: every frame makes every blade afresh,
 * already bent.
 *
 * A blade is a few splats strung along a curve from its root to its tip, each one
 * long along the blade, a narrow strip across it, and paper thin. The curve is a
 * quadratic Bézier whose tip leans by the blade's own rest lean plus the wind, so
 * it bends from the root and curls most at the tip, the way a stem does.
 *
 * The wind is a breeze everyone feels, gusts that travel across the field as a
 * slowly changing noise pattern, and a quick shiver per blade. Bent blades show
 * more of their lighter face to the sky, so a gust reads as a brighter wave rolling
 * through, the look of wind over a real meadow.
 */

import { GpuSplatMath, GpuSplats, SplatCollection, type SplatNode, type SplatObject, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';

const {
    Fn,
    abs,
    cos,
    cross,
    dot,
    float,
    fract,
    length,
    max,
    min,
    mix,
    mx_noise_float,
    normalize,
    pow,
    sin,
    smoothstep,
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

/* the scene's numbers */

/** Towards the sun: low, and ahead of the opening view, so the field is backlit. */
export const SUN_DIRECTION = new THREE.Vector3(0.32, 0.13, -1).normalize();

/**
 * Colours are sRGB-encoded, as splats blend. The haze is what the far field fades
 * into, and the sky's horizon is the same colour, so the field's edge disappears.
 */
export const HAZE: [number, number, number] = [0.95, 0.8, 0.6];
const SUN: [number, number, number] = [1.0, 0.82, 0.56];

const FIELD = {
    radius: 34,
    blades: 240_000,
    segments: 5,
    ground: 120_000,
    /** Below 1, blades crowd towards the middle, where the camera stands. */
    spread: 0.62,
    /** Where the fade into haze starts and is complete, metres from the camera. */
    fog: [6, 34],
};

const BLADE = {
    height: [0.3, 0.8],
    /** Half-width near the root (a splat's standard deviation), metres. */
    width: 0.009,
    thickness: 0.0015,
    /** How far a blade leans with no wind, radians. */
    restLean: 0.4,
    /** Far blades grow wider with distance, up to this, so the far field fills in. */
    farGrowth: 3,
    /** The darkest a blade's root gets, down in the thatch. */
    rootShade: 0.35,
    deep: [0.12, 0.2, 0.05],
    fresh: [0.36, 0.5, 0.12],
    straw: [0.74, 0.62, 0.32],
    tip: [0.86, 0.78, 0.42],
};

const WIND = {
    /** Where it blows towards, in xz. */
    direction: [0.85, -0.5],
    /** How fast gusts travel across the field, m/s. */
    speed: 3.4,
    /** The size of a gust: one over metres. */
    scale: 0.085,
    /** Bend everyone has all the time, radians. */
    breeze: 0.16,
    /** Extra bend at a full gust. */
    gust: 0.8,
    /** A quick per-blade shiver, radians, and its rate in Hz. */
    flutter: 0.07,
    flutterRate: 2.2,
    /** How much lighter a fully bent blade shows. */
    sheen: 0.22,
};

const GROUND = {
    thatch: [0.2, 0.16, 0.07],
    moss: [0.13, 0.17, 0.05],
};

/* uniforms */

/** Seconds since the start. Set once a frame. */
export const time = uniform(0);
/** Where the camera is, for distance fog and backlight. Set once a frame. */
export const eye = uniform(new THREE.Vector3());

/* helpers */

const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);

/** Four hashes in [0, 1) of a seed. */
const hash4 = Fn(([i]: TslNode[]) => {
    const p = fract(vec3(i).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
    p.addAssign(dot(p, p.yzx.add(33.33)));
    const a = fract(p.xxy.add(p.yzz).mul(p.zyx));
    const w = fract(sin(i.mul(78.233)).mul(43758.5453));
    return vec4(a, w);
}).setLayout({ name: 'grassHash', type: 'vec4', inputs: [{ name: 'i', type: 'float' }] });

/** Shortest-arc rotation taking +Y onto `dir`. */
const alignY = (dir: TslNode): TslNode => normalize(vec4(cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));

/**
 * Point `i` of `count` spread evenly over the field: a sunflower spiral, so there
 * are no clumps and no gaps, crowded towards the middle by `spread`. Returns the
 * xz point and how far out it is, 0..1.
 */
function spiral(i: TslNode, count: number, jitter: TslNode): { xz: TslNode; out: TslNode } {
    const t = i.add(jitter.x.mul(0.8)).div(count);
    const out = pow(t, FIELD.spread);
    const angle = i.mul(2.399963).add(jitter.y.mul(0.5));
    return { xz: vec2(cos(angle), sin(angle)).mul(out.mul(FIELD.radius)), out };
}

/** The far field's finish: fade towards the haze with distance, and out at the edge. */
function distance(center: TslNode, out: TslNode, rgb: TslNode, opacity: TslNode): { rgb: TslNode; opacity: TslNode } {
    const d = length(center.sub(eye));
    const fog = smoothstep(FIELD.fog[0], FIELD.fog[1], d);
    return {
        rgb: mix(rgb, v3(HAZE), fog.mul(0.9)),
        opacity: opacity.mul(smoothstep(1, 0.86, out)),
    };
}

/** How much wider far splats draw, so a distant blade isn't thinner than a pixel. */
const farWidth = (center: TslNode): TslNode => min(max(length(center.sub(eye)).div(5), 1), BLADE.farGrowth);

/** One splat object, generated from its index alone. */
function generated(count: number, body: (index: TslNode) => SplatNode): SplatObject {
    return SplatCollection.object({ count, generator: { generateSplat: body } });
}

/* the blades */

function blades(): SplatObject {
    const { segments } = FIELD;
    const sun = vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z);
    const windDir = normalize(vec2(WIND.direction[0], WIND.direction[1]));

    return generated(FIELD.blades * segments, (index) => {
        const blade = float(index.div(uint(segments)));
        const along = float(index.mod(uint(segments)))
            .add(0.5)
            .div(segments)
            .toVar();

        const a = hash4(blade.mul(1.37).add(0.5)).toVar();
        const b = hash4(blade.mul(7.13).add(3.1)).toVar();
        const c = hash4(blade.mul(3.71).add(11.7)).toVar();

        const { xz, out } = spiral(blade, FIELD.blades, a);
        const root = vec3(xz.x, 0, xz.y).toVar();

        // Taller in patches, and patches of dry straw among the green.
        const lush = mx_noise_float(xz.mul(0.11)).mul(0.5).add(0.5);
        const height = mix(BLADE.height[0], BLADE.height[1], pow(b.x, 0.7))
            .mul(mix(0.7, 1.25, lush))
            .toVar();
        const dryPatch = smoothstep(0.05, 0.55, mx_noise_float(xz.mul(0.05).add(7.3)));
        const dry = smoothstep(0.85, 1, c.z.add(dryPatch.mul(0.55)));

        // The wind: gusts are noise sliding downwind and slowly changing shape.
        const drift = windDir.mul(time.mul(WIND.speed));
        const gustNoise = mx_noise_float(vec3(xz.sub(drift).mul(WIND.scale), time.mul(0.12)));
        const gust = smoothstep(-0.25, 0.65, gustNoise).toVar();
        const flutter = sin(
            time
                .mul(Math.PI * 2 * WIND.flutterRate)
                .mul(c.x.mul(0.5).add(0.75))
                .add(c.y.mul(Math.PI * 2)),
        )
            .mul(WIND.flutter)
            .mul(gust.add(0.3));
        const leanAngle = b.z.mul(Math.PI * 2);
        const lean = vec2(cos(leanAngle), sin(leanAngle)).mul(b.w.mul(BLADE.restLean));
        const bend = lean.add(windDir.mul(gust.mul(WIND.gust).add(WIND.breeze).add(flutter))).toVar();
        const angle = min(length(bend), 1.35).toVar();
        const bendDir = bend.div(max(length(bend), 1e-4)).toVar();

        // The stem: a Bézier from the root, up, then over towards the tip.
        const over = vec3(bendDir.x, 0, bendDir.y);
        const tip = root.add(
            over
                .mul(sin(angle))
                .add(vec3(0, cos(angle), 0))
                .mul(height),
        );
        const knee = root.add(vec3(0, height.mul(0.6), 0)).add(over.mul(height.mul(sin(angle)).mul(0.25)));
        const s = along;
        const center = root
            .mul(s.oneMinus().mul(s.oneMinus()))
            .add(knee.mul(s.oneMinus().mul(s).mul(2)))
            .add(tip.mul(s.mul(s)))
            .toVar();
        const tangent = normalize(knee.sub(root).mul(s.oneMinus()).add(tip.sub(knee).mul(s)));

        // Facing turns the blade about its own length; then it's stood along the stem.
        const facing = b.y.mul(Math.PI);
        const quaternion = GpuSplatMath.quatMul(alignY(tangent), vec4(0, sin(facing), 0, cos(facing))).toVar();

        const widen = farWidth(center);
        const taper = mix(1, 0.3, pow(s, 1.6));
        const scales = vec3(
            float(BLADE.width).mul(taper).mul(widen),
            height.div(segments).mul(0.62),
            float(BLADE.thickness).mul(widen),
        );

        // Colour: dark in the thatch, lighter and warmer towards the tip.
        const green = mix(v3(BLADE.deep), v3(BLADE.fresh), c.w);
        const base = mix(green, v3(BLADE.straw), dry);
        const body = mix(base, mix(base, v3(BLADE.tip), 0.45), smoothstep(0.3, 1, s));
        const shade = mix(BLADE.rootShade, 1, smoothstep(0, 0.85, s));

        // Light: a soft two-sided sun on the blade's face; through it when you look
        // towards the sun; and a sheen on blades the wind has laid over.
        const normal = GpuSplatMath.quatRotate(quaternion, vec3(0, 0, 1));
        const facingSun = abs(dot(normal, sun)).mul(0.55).add(0.45);
        const view = normalize(center.sub(eye));
        const through = pow(max(dot(view, sun), 0), 5)
            .mul(smoothstep(0.25, 1, s))
            .mul(0.85);
        const sheen = gust.mul(WIND.sheen).mul(s);
        const lit = body
            .mul(shade)
            .mul(v3(SUN).mul(facingSun).mul(0.75).add(0.35))
            .add(
                v3(SUN)
                    .mul(through)
                    .mul(mix(0.6, 1, dry)),
            )
            .add(sheen);

        const finish = distance(center, out, lit, float(1));
        return GpuSplats.Splat(center, scales, quaternion, finish.rgb, finish.opacity, uint(index));
    });
}

/* the ground */

function ground(): SplatObject {
    // Each splat covers about its share of the field, so they overlap into a floor.
    const share = Math.sqrt((Math.PI * FIELD.radius ** 2) / FIELD.ground);

    return generated(FIELD.ground, (index) => {
        const i = float(index);
        const a = hash4(i.mul(2.17).add(91.3)).toVar();
        const b = hash4(i.mul(5.31).add(17.9)).toVar();
        const { xz, out } = spiral(i, FIELD.ground, a);
        const center = vec3(xz.x, b.x.mul(0.01), xz.y);

        const size = mix(0.75, 1.4, out).mul(share).mul(b.y.mul(0.5).add(0.8));
        const scales = vec3(size, 0.004, size.mul(b.z.mul(0.5).add(0.5)));
        const turn = b.w.mul(Math.PI);
        const quaternion = vec4(0, sin(turn), 0, cos(turn));

        const mottle = mx_noise_float(xz.mul(0.7)).mul(0.5).add(0.5);
        const rgb = mix(v3(GROUND.moss), v3(GROUND.thatch), mottle).mul(a.w.mul(0.3).add(0.85));

        const finish = distance(center, out, rgb, float(1));
        return GpuSplats.Splat(center, scales, quaternion, finish.rgb, finish.opacity, uint(index));
    });
}

/* the field */

export type Field = { objects: SplatObject[] };

export function initField(): Field {
    return { objects: [ground(), blades()] };
}

export function updateField(elapsed: number, camera: THREE.Camera): void {
    time.value = elapsed;
    eye.value.copy(camera.position);
}
