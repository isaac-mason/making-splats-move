import { GpuSplatMath, GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';

const {
    abs,
    cos,
    cross,
    dot,
    exp,
    float,
    floor,
    hash,
    max,
    min,
    mix,
    normalize,
    pow,
    reflect,
    sign,
    sin,
    smoothstep,
    sqrt,
    uint,
    uniform,
    vec3,
    vec4,
} = TSL;

/* settings */

/** How many bursts are kept, and how many pieces each fires. */
const BURSTS = { slots: 16, pieces: 1600 };

/** A cone this wide (radians) along where you clicked, pieces leaving at this speed (m/s) give or take. */
const SHOT = { cone: 0.2, speed: [9, 22] };

/** Air brake (per second), weight (what's left after the air's lift on a flat sheet: about 1 m/s fall), sway, and tumble (radians a second). */
const PAPER = { drag: [2.6, 4], weight: 3.4, sway: [0.12, 0.35], swayRate: [0.7, 1.5], tumble: [5, 14] };

/** Half-sizes in metres; share of dots; opacity past 1 with lodInflate off is a hard edge `edge` standard deviations out. */
const PIECE = { length: 0.016, width: 0.009, dots: 0.25, opacity: 2, edge: 4.3 };

/** How long a burst's pieces lie on the floor before fading, and how long they take to fade, seconds. */
const LINGER = { stay: 40, fade: 3 };

/** Confetti colours, in sRGB, and the foils: how many pieces are foil, their colours. */
const COLOURS = ['#ff4d6d', '#ffb703', '#3a86ff', '#06d6a0', '#8338ec', '#fb5607', '#ff99c8', '#ffffff'];
const FOIL = { share: 0.14, colours: ['#e2b84a', '#d9dde3'] };

/** The light: where it comes from, how much it lights a sheet facing it, and the soft fill on the rest. */
export const LIGHT = { direction: new THREE.Vector3(-0.4, 1, 0.55).normalize(), key: 0.6, fill: 0.5, glint: 2.2 };

export const FLOOR = 0;

/* the bursts */

/** Burst slot `i`: (where it was fired from, when: negative while unused), (which way, unused). */
const fired = Array.from({ length: BURSTS.slots }, () => uniform(new THREE.Vector4(0, 0, 0, -1e3)));
const aimed = Array.from({ length: BURSTS.slots }, () => uniform(new THREE.Vector4(0, 1, 0, 1)));
/** Seconds since the start, and where you are, for the glints. */
const time = uniform(0);
const eye = uniform(new THREE.Vector3());

const ofSlot = (list: TslNode[], slot: TslNode): TslNode =>
    list.reduce<TslNode>((picked, u, i) => (i === 0 ? u : slot.equal(uint(i)).select(u, picked)), list[0]);

/* splats */

const v3 = (hex: string): TslNode => {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
};
const pickColour = (list: string[], at: TslNode): TslNode => {
    const i = min(floor(at.mul(list.length)), list.length - 1);
    return list.reduce<TslNode>((picked, c, k) => (k === 0 ? v3(c) : i.equal(float(k)).select(v3(c), picked)), v3(list[0]));
};

const sphereDir = (u: TslNode, v: TslNode): TslNode => {
    const z = u.mul(2).sub(1);
    const ring = sqrt(max(z.mul(z).oneMinus(), 0));
    const a = v.mul(Math.PI * 2);
    return vec3(cos(a).mul(ring), z, sin(a).mul(ring));
};

const turnAbout = (axis: TslNode, angle: TslNode): TslNode => vec4(axis.mul(sin(angle.mul(0.5))), cos(angle.mul(0.5)));

function quatFromBasis(x: TslNode, y: TslNode, z: TslNode): TslNode {
    const w = sqrt(max(x.x.add(y.y).add(z.z).add(1), 0)).mul(0.5);
    const qx = sqrt(max(x.x.sub(y.y).sub(z.z).add(1), 0))
        .mul(0.5)
        .mul(sign(y.z.sub(z.y)));
    const qy = sqrt(max(y.y.sub(x.x).sub(z.z).add(1), 0))
        .mul(0.5)
        .mul(sign(z.x.sub(x.z)));
    const qz = sqrt(max(z.z.sub(x.x).sub(y.y).add(1), 0))
        .mul(0.5)
        .mul(sign(x.y.sub(y.x)));
    return normalize(vec4(qx, qy, qz, w));
}

function generateSplat(index: TslNode) {
    const slot = index.div(uint(BURSTS.pieces));
    const h = (n: number) => hash(index.mul(uint(17)).add(uint(n)));
    const from = ofSlot(fired, slot).toVar();
    const aim = ofSlot(aimed, slot).toVar();
    const t = time.sub(from.w).toVar();

    const coneSide = normalize(
        cross(
            aim.xyz,
            abs(aim.y)
                .lessThan(0.95)
                .select(vec3(0, 1, 0), vec3(1, 0, 0)),
        ),
    );
    const coneUp = cross(aim.xyz, coneSide);
    const spread = sqrt(h(0)).mul(SHOT.cone);
    const around = h(1).mul(Math.PI * 2);
    const dir = aim.xyz
        .mul(cos(spread))
        .add(coneSide.mul(cos(around).mul(sin(spread))))
        .add(coneUp.mul(sin(around).mul(sin(spread))));
    const speed = mix(SHOT.speed[0], SHOT.speed[1], h(2));

    // In flight: the velocity eases from the shot to a slow fall, fast (paper's all drag). Where
    // it reaches the floor, from the same formula once the shot has died away: it stops there.
    const drag = mix(PAPER.drag[0], PAPER.drag[1], h(3)).toVar();
    const v0 = dir.mul(speed);
    const fall = float(-PAPER.weight).div(drag);
    const landed = from.y.add(v0.y.sub(fall).div(drag)).div(fall.negate()).max(0).toVar();
    const flying = min(max(t, 0), landed).toVar();
    const eased = exp(drag.negate().mul(flying)).oneMinus().div(drag);
    // As it slows it sways from side to side, one way and back, its own way and pace.
    const swayAxis = normalize(vec3(cos(h(4).mul(Math.PI * 2)), 0, sin(h(4).mul(Math.PI * 2))));
    const swayRate = mix(PAPER.swayRate[0], PAPER.swayRate[1], h(5)).mul(Math.PI * 2);
    const sway = sin(flying.mul(swayRate).add(h(6).mul(6.28)))
        .mul(mix(PAPER.sway[0], PAPER.sway[1], h(7)))
        .mul(smoothstep(0, 0.8, flying));
    const at = from.xyz
        .add(vec3(v0.x.mul(eased), v0.y.sub(fall).mul(eased).add(fall.mul(flying)), v0.z.mul(eased)))
        .add(swayAxis.mul(sway))
        .toVar();
    const down = t.greaterThanEqual(landed);
    const lying = vec3(at.x, float(FLOOR + 0.002).add(h(8).mul(0.004)), at.z);

    const start = vec4(sphereDir(h(9), h(10)).mul(sin(h(11).mul(Math.PI))), cos(h(11).mul(Math.PI))).toVar();
    const tumbleAxis = sphereDir(h(12), h(13));
    const tumble = GpuSplatMath.quatMul(turnAbout(tumbleAxis, flying.mul(mix(PAPER.tumble[0], PAPER.tumble[1], h(14)))), start);
    const yaw = h(15).mul(Math.PI * 2);
    const flat = quatFromBasis(vec3(cos(yaw), 0, sin(yaw)), vec3(sin(yaw), 0, cos(yaw).negate()), vec3(0, 1, 0));
    const quaternion = down.select(flat, tumble).toVar();

    // Lit as a sheet, from either side: brighter turned to the light, so it flashes as it tumbles;
    // foil glints when it catches the light towards you.
    const normal = GpuSplatMath.quatRotate(quaternion, vec3(0, 0, 1));
    const light = vec3(LIGHT.direction.x, LIGHT.direction.y, LIGHT.direction.z);
    const facing = abs(dot(normal, light));
    const isFoil = h(16).lessThan(FOIL.share);
    const paint = isFoil.select(pickColour(FOIL.colours, h(17)), pickColour(COLOURS, h(17)));
    const towardsEye = normalize(eye.sub(at));
    const mirrored = reflect(light.negate(), normal.mul(sign(dot(normal, towardsEye))));
    const glint = pow(max(dot(mirrored, towardsEye), 0), 24).mul(LIGHT.glint);
    const shade = facing.mul(LIGHT.key).add(LIGHT.fill);
    const rgb = paint.mul(isFoil.select(shade.mul(0.7).add(glint), shade));

    const isDot = h(18).lessThan(PIECE.dots);
    const size = h(19).mul(0.5).add(0.75);
    const scales = vec3(isDot.select(float(PIECE.width * 1.15), float(PIECE.length)), PIECE.width, 0.0005)
        .mul(size)
        .div(PIECE.edge);

    const left = smoothstep(LINGER.stay + LINGER.fade, LINGER.stay, t);
    const opacity = t.greaterThan(0).select(left.mul(PIECE.opacity), float(0));
    return GpuSplats.Splat(down.select(lying, at), scales, quaternion, rgb, opacity, uint(index));
}

/* the confetti, from the outside */

export type Confetti = {
    object: SplatObject;
    fire: (at: THREE.Vector3, towards: THREE.Vector3) => void;
    update: (elapsed: number, from: THREE.Vector3) => void;
};

export function initConfetti(): Confetti {
    let next = 0;
    let now = 0;
    // Pieces keep their size (lodInflate off): opacity past 1 is a crisp edge, not a bigger splat.
    const object = SplatCollection.object({
        count: BURSTS.slots * BURSTS.pieces,
        generator: { generateSplat },
        params: { lodInflate: false },
    });
    return {
        object,
        fire(at, towards) {
            (fired[next].value as THREE.Vector4).set(at.x, at.y, at.z, now);
            (aimed[next].value as THREE.Vector4).set(towards.x, towards.y, towards.z, 0);
            next = (next + 1) % BURSTS.slots;
        },
        update(elapsed, from) {
            now = elapsed;
            time.value = elapsed;
            (eye.value as THREE.Vector3).copy(from);
        },
    };
}
