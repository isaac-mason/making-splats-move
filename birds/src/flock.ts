import {
    GpuSplatMath,
    GpuSplats,
    SplatCollection,
    type SplatObject,
    TSL,
    type TslNode,
    WgpuBuffer,
    WgpuCompute,
    WgpuComputeBatch,
} from 'spark-radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

const {
    If,
    atomicAdd,
    atomicLoad,
    atomicStore,
    clamp,
    cos,
    cross,
    dot,
    exp,
    float,
    floor,
    hash,
    int,
    length,
    max,
    min,
    mix,
    mx_noise_vec3,
    normalize,
    pow,
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

const FLOCK = {
    birds: 1 << 13,
    /** Metres a second: what a bird holds to, how fast it gets back to it, and the limits. */
    speed: 13,
    hold: 1.5,
    speedRange: [7, 21],
    /** How fast a bird turns towards where the flock is carrying it, and towards its neighbours, per second. */
    steer: 1.6,
    align: 1.2,
    /** Birds a grid cell holds, usually; past twice that, they edge apart, this hard. */
    usual: 3.6,
    crowd: 4,
    /** Not below this, metres: they stay up in the sky. */
    floor: 40,
};

/** Wheeling round the roost: radians a second at most, seconds round the reversal, and how far the axis leans. */
const WHEEL = { rate: 0.25, period: 40, lean: 0.35 };

/** Metres a second, eddy size, drift (noise units a second), and the vertical share, so the flock stays wider than tall. */
const SWIRL = { speed: 9, scale: 40, drift: 0.035, flat: 0.45 };

/** Metres: free inside `free` of the roost, pulled back past it this hard. */
const ENVELOPE = { radii: [42, 17, 42], free: 0.55, pull: 28 };

/** A pass every `every` s at `speed`, diving through the roost `lead` s in; birds within `reach` m flee at `flee` m/s². */
const FALCON = { every: 13, speed: 30, lead: 6.5, dive: 0.3, reach: 18, flee: 110 };

/** Alarm spreads to neighbours past `hear`, then the bird is immune for `refract` s, so a fright crosses the flock as a ~45 m/s band and doesn't echo. */
const FRIGHT = { hear: 0.06, rise: 5, fall: 2, refract: 4, dodge: 25, falcon: 0.25, cursor: 0.2 };

/** Reach is an angle (same on screen at any distance) but never under `least` m; `swipe` is rad/s; `fade` and `calm` are seconds. */
const CURSOR = { reach: [0.16, 0.34], least: 10, flee: [35, 120], swipe: 1.2, fade: 0.25, calm: 0.3 };

/** Bird frame in metres: x out the right wing, y up its back, z ahead; a touch bigger than a real starling. Wings hang off the shoulder via the arm, then the hand. */
const BIRD = {
    size: 1.3,
    shoulder: [0.022, 0.01, 0.015],
    /** How far along the arm its tip is, where the hand hinges. */
    armTip: 0.12,
    /** How far the hand is swept back, radians. */
    sweep: 0.45,
    parts: {
        body: { at: [0, 0, 0], arm: 0, hand: 0, turn: 'body', sigma: [0.028, 0.024, 0.075] },
        head: { at: [0, 0.012, 0.085], arm: 0, hand: 0, turn: 'body', sigma: [0.024, 0.022, 0.026] },
        tail: { at: [0, -0.004, -0.11], arm: 0, hand: 0, turn: 'body', sigma: [0.03, 0.004, 0.05] },
        arm: { at: 'shoulder', arm: 0.065, hand: 0, turn: 'arm', sigma: [0.05, 0.003, 0.036] },
        hand: { at: 'shoulder', arm: 0.12, hand: 0.075, turn: 'hand', sigma: [0.066, 0.002, 0.022] },
    },
    falcon: 2.2,
} as const;

/** Beats a second (±15%); swing, fold, lag and dihedral in radians; `glide` is the share of time spent gliding. */
const WINGS = { beat: 5.2, swing: 0.75, fold: 0.35, lag: 0.9, dihedral: 0.1, glide: 0.35 };

/** sRGB. Near-black; the amber the wings take on with the glow behind them. */
const PLUMAGE = { body: [0.055, 0.05, 0.055], wing: [0.07, 0.065, 0.07], glow: [1.0, 0.55, 0.3], through: 0.4 };

/** Where the sun went: 4° under the horizon, 20° right of the way you first face (down -z). */
export const SUN_DIRECTION = new THREE.Vector3(Math.sin(0.35), -0.07, -Math.cos(0.35)).normalize();

/** Seconds of flight before the first frame, so the flock already has a shape. */
const WARMUP = 8;
const STEP = 1 / 30;

/* the roost and the falcon */

/** You're at the origin: 85 m up and 40–65 m out, mostly on the glow side. */
export function roostAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    const azimuth = 0.6 * Math.sin(t / 71) + 0.25 * Math.sin(t / 47 + 1);
    const distance = 52 + 13 * Math.sin(t / 41);
    const height = 85 + 8 * Math.sin(t / 37 + 2);
    return out.set(Math.sin(azimuth) * distance, height, -Math.cos(azimuth) * distance);
}

const scratch = new THREE.Vector3();

function falconAt(t: number, position: THREE.Vector3, velocity: THREE.Vector3): number {
    const pass = Math.floor(t / FALCON.every);
    const into = t - pass * FALCON.every;
    const roost = roostAt(pass * FALCON.every + FALCON.lead, scratch);
    const heading = pass * 2.4;
    velocity.set(Math.cos(heading), -FALCON.dive, Math.sin(heading)).normalize().multiplyScalar(FALCON.speed);
    position.copy(roost).addScaledVector(velocity, into - FALCON.lead);
    return Math.min(THREE.MathUtils.smoothstep(into, 0, 1.5), THREE.MathUtils.smoothstep(into, FALCON.every, FALCON.every - 1.5));
}

/* uniforms: the kernels' and the splats' own, set together (one shared between the two binds wrong) */

const sim = {
    dt: uniform(0),
    roost: uniform(new THREE.Vector3()),
    origin: uniform(new THREE.Vector3()),
    spin: uniform(new THREE.Vector3()),
    drift: uniform(new THREE.Vector3()),
    falcon: uniform(new THREE.Vector3()),
    cursorFrom: uniform(new THREE.Vector3()),
    cursorAlong: uniform(new THREE.Vector3(0, 0, -1)),
    cursorOn: uniform(0),
    cursorScare: uniform(0),
};

const look = {
    time: uniform(0),
    roost: uniform(new THREE.Vector3()),
    eye: uniform(new THREE.Vector3()),
    falcon: uniform(new THREE.Vector3()),
    falconVelocity: uniform(new THREE.Vector3()),
    falconSeen: uniform(0),
};

/* the grid */

/** Per-cell velocities and bird counts, added atomically (fixed point) by each bird to its eight nearest cells; cleared every frame. */
const GRID = { cell: 4, dims: [26, 12, 26], velocity: 256, count: 1024 };
/** Per cell: velocity xyz, how many birds, and how much catching alarm. */
const CHANNELS = 5;
const CELLS = GRID.dims[0] * GRID.dims[1] * GRID.dims[2];

/** A position's place in the grid, in cells from the first cell's centre: the corner below it, and how far past. */
function gridPlace(p: TslNode) {
    const g = p.sub(sim.origin).div(GRID.cell).sub(0.5).toVar();
    const base = floor(g).toVar();
    return { base, f: g.sub(base).toVar() };
}

function corners(
    base: TslNode,
    f: TslNode,
    visit: (weight: TslNode, slot: TslNode, inside: TslNode, sx: number, sy: number, sz: number) => void,
) {
    const [nx, ny, nz] = GRID.dims;
    for (let c = 0; c < 8; c++) {
        const bx = c & 1;
        const by = (c >> 1) & 1;
        const bz = c >> 2;
        const at = base.add(vec3(bx, by, bz));
        const inside = at.x
            .greaterThanEqual(0)
            .and(at.y.greaterThanEqual(0))
            .and(at.z.greaterThanEqual(0))
            .and(at.x.lessThan(nx))
            .and(at.y.lessThan(ny))
            .and(at.z.lessThan(nz));
        const wx = bx ? f.x : f.x.oneMinus();
        const wy = by ? f.y : f.y.oneMinus();
        const wz = bz ? f.z : f.z.oneMinus();
        const slot = uint(at.z.mul(ny).add(at.y).mul(nx).add(at.x).mul(CHANNELS));
        visit(wx.mul(wy).mul(wz), slot, inside, bx ? 1 : -1, by ? 1 : -1, bz ? 1 : -1);
    }
}

const fixed = (x: TslNode): TslNode => int(floor(x.add(0.5)));

/* kernels */

function swirlAt(offset: TslNode): TslNode {
    const q = offset.div(SWIRL.scale).add(sim.drift).toVar();
    const e = 0.05;
    const dx = mx_noise_vec3(q.add(vec3(e, 0, 0)))
        .sub(mx_noise_vec3(q.sub(vec3(e, 0, 0))))
        .toVar();
    const dy = mx_noise_vec3(q.add(vec3(0, e, 0)))
        .sub(mx_noise_vec3(q.sub(vec3(0, e, 0))))
        .toVar();
    const dz = mx_noise_vec3(q.add(vec3(0, 0, e)))
        .sub(mx_noise_vec3(q.sub(vec3(0, 0, e))))
        .toVar();
    const curl = vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x)).div(2 * e);
    return curl.mul(vec3(SWIRL.speed, SWIRL.speed * SWIRL.flat, SWIRL.speed));
}

type Flock = {
    pos: WgpuBuffer<'float32x4'>;
    vel: WgpuBuffer<'float32x4'>;
    up: WgpuBuffer<'float32x4'>;
    grid: WgpuBuffer<'sint32'>;
    init: WgpuCompute;
    clear: WgpuCompute;
    scatter: WgpuCompute;
    fly: WgpuCompute;
    batch: WgpuComputeBatch;
};

const perBird = (label: string, body: (index: TslNode) => void) =>
    new WgpuCompute({
        label,
        body: ({ index }) => {
            If(index.lessThan(uint(FLOCK.birds)), () => body(index));
        },
    });

function makeFlock(renderer: WebGPURenderer): Flock {
    const birds = FLOCK.birds;
    // pos: xyz and the wingbeat's phase; vel: xyz and its alarm; up: which way its back faces, banked
    // into turns, and how long until it can be startled again.
    const pos = new WgpuBuffer({ renderer, format: 'float32x4', count: birds });
    const vel = new WgpuBuffer({ renderer, format: 'float32x4', count: birds });
    const up = new WgpuBuffer({ renderer, format: 'float32x4', count: birds });
    const grid = new WgpuBuffer({ renderer, format: 'sint32', count: CELLS * CHANNELS, atomic: true });

    const init = perBird('birdsInit', (index) => {
        const h = (k: number) => hash(index.mul(uint(7)).add(uint(k)));
        const z = h(1).mul(2).sub(1);
        const a = h(2).mul(Math.PI * 2);
        const r = h(3).pow(1 / 3);
        const dir = vec3(sqrt(z.mul(z).oneMinus()).mul(cos(a)), z, sqrt(z.mul(z).oneMinus()).mul(sin(a)));
        const offset = dir
            .mul(r)
            .mul(vec3(28, 11, 28))
            .toVar();
        pos.element(index).assign(vec4(sim.roost.add(offset), h(4).mul(Math.PI * 2)));
        vel.element(index).assign(vec4(normalize(cross(vec3(0, 1, 0), offset).add(vec3(0.01, 0, 0))).mul(FLOCK.speed), 0));
        up.element(index).assign(vec4(0, 1, 0, 0));
    });

    const clear = new WgpuCompute({
        label: 'birdsClear',
        body: ({ index }) => {
            If(index.lessThan(uint(CELLS * CHANNELS)), () => {
                atomicStore(grid.element(index), int(0));
            });
        },
    });

    const scatter = perBird('birdsScatter', (index) => {
        const p = pos.element(index).xyz.toVar();
        const v = vel.element(index).toVar();
        // Catching only while its alarm is rising, before it's settled into not hearing.
        const catching = up.element(index).w.greaterThan(0).select(float(0), v.w);
        const { base, f } = gridPlace(p);
        corners(base, f, (weight, slot, inside) => {
            If(inside, () => {
                const w = weight.toVar();
                atomicAdd(grid.element(slot), fixed(v.x.mul(w).mul(GRID.velocity)));
                atomicAdd(grid.element(slot.add(uint(1))), fixed(v.y.mul(w).mul(GRID.velocity)));
                atomicAdd(grid.element(slot.add(uint(2))), fixed(v.z.mul(w).mul(GRID.velocity)));
                atomicAdd(grid.element(slot.add(uint(3))), fixed(w.mul(GRID.count)));
                atomicAdd(grid.element(slot.add(uint(4))), fixed(w.mul(catching).mul(GRID.count)));
            });
        });
    });

    const fly = perBird('birdsFly', (index) => {
        const state = pos.element(index).toVar();
        const p = state.xyz.toVar();
        const v = vel.element(index).xyz.toVar();
        const alarm = vel.element(index).w.toVar();
        const rest = up.element(index).w.toVar();
        const dt = sim.dt;

        const n = float(0).toVar();
        const sum = vec3(0).toVar();
        const thicker = vec3(0).toVar();
        const heardSum = float(0).toVar();
        const louder = vec3(0).toVar();
        const { base, f } = gridPlace(p);
        corners(base, f, (weight, slot, inside, sx, sy, sz) => {
            If(inside, () => {
                const count = float(atomicLoad(grid.element(slot.add(uint(3)))))
                    .div(GRID.count)
                    .toVar();
                const velocity = vec3(
                    float(atomicLoad(grid.element(slot))),
                    float(atomicLoad(grid.element(slot.add(uint(1))))),
                    float(atomicLoad(grid.element(slot.add(uint(2))))),
                ).div(GRID.velocity);
                const catching = float(atomicLoad(grid.element(slot.add(uint(4)))))
                    .div(GRID.count)
                    .toVar();
                n.addAssign(weight.mul(count));
                sum.addAssign(weight.mul(velocity));
                heardSum.addAssign(weight.mul(catching));
                const wx = sx > 0 ? f.x : f.x.oneMinus();
                const wy = sy > 0 ? f.y : f.y.oneMinus();
                const wz = sz > 0 ? f.z : f.z.oneMinus();
                const slope = vec3(wy.mul(wz).mul(sx), wx.mul(wz).mul(sy), wx.mul(wy).mul(sz)).toVar();
                thicker.addAssign(slope.mul(count));
                louder.addAssign(slope.mul(catching));
            });
        });

        const offset = p.sub(sim.roost).toVar();
        const want = cross(sim.spin, offset).add(swirlAt(offset));
        const a = want.sub(v).mul(FLOCK.steer).toVar();

        If(n.greaterThan(0.001), () => {
            a.addAssign(
                sum
                    .div(n)
                    .sub(v)
                    .mul(FLOCK.align)
                    .mul(min(n.div(FLOCK.usual), 1)),
            );
        });
        const crowd = clamp(n.div(FLOCK.usual).sub(2), 0, 2);
        a.subAssign(thicker.div(FLOCK.usual).mul(FLOCK.crowd).mul(crowd));

        const [rx, ry, rz] = ENVELOPE.radii;
        const out = length(offset.div(vec3(rx, ry, rz)));
        const beyond = max(out.sub(ENVELOPE.free), 0);
        a.subAssign(normalize(offset.add(vec3(0, 1e-4, 0))).mul(beyond.mul(beyond).mul(ENVELOPE.pull)));
        a.y.addAssign(max(float(FLOCK.floor).sub(p.y), 0).mul(0.8));

        const speed = max(length(v), 0.001);
        a.addAssign(v.div(speed).mul(float(FLOCK.speed).sub(speed).mul(FLOCK.hold)));

        const fromFalcon = p.sub(sim.falcon).toVar();
        const near = smoothstep(FALCON.reach, 0, length(fromFalcon));
        a.addAssign(normalize(fromFalcon.add(vec3(0, 1e-4, 0))).mul(near.mul(near).mul(FALCON.flee)));

        const toBird = p.sub(sim.cursorFrom).toVar();
        const depth = max(dot(toBird, sim.cursorAlong), 0);
        const fromLine = toBird.sub(sim.cursorAlong.mul(depth)).toVar();
        const scare = sim.cursorScare;
        const reach = max(depth.mul(mix(CURSOR.reach[0], CURSOR.reach[1], scare)), CURSOR.least);
        const nearCursor = smoothstep(reach, 0, length(fromLine)).mul(sim.cursorOn).toVar();
        const flee = mix(CURSOR.flee[0], CURSOR.flee[1], scare);
        a.addAssign(normalize(fromLine.add(vec3(0, 1e-4, 0))).mul(nearCursor.mul(nearCursor).mul(flee)));

        // Fright: startled by the falcon, a swipe, or neighbours' rising alarm; rising,
        // then falling and deaf for a while. Alarmed, it dodges away from where it came from.
        const heard = n.greaterThan(0.001).select(heardSum.div(n), float(0));
        const startled = near
            .greaterThan(FRIGHT.falcon)
            .or(nearCursor.mul(scare).greaterThan(FRIGHT.cursor))
            .or(heard.greaterThan(FRIGHT.hear));
        If(rest.lessThanEqual(0).and(alarm.lessThanEqual(0)).and(startled), () => {
            alarm.assign(0.01);
        });
        If(rest.lessThanEqual(0).and(alarm.greaterThan(0)), () => {
            alarm.addAssign(dt.mul(FRIGHT.rise));
            If(alarm.greaterThanEqual(1), () => {
                alarm.assign(1);
                rest.assign(1);
            });
        }).ElseIf(rest.greaterThan(0), () => {
            alarm.assign(max(alarm.sub(dt.mul(FRIGHT.fall)), 0));
            rest.subAssign(dt.div(FRIGHT.refract));
        });
        a.subAssign(normalize(louder.add(vec3(0, 1e-4, 0))).mul(alarm.mul(FRIGHT.dodge)));

        const next = v.add(a.mul(dt)).toVar();
        const s = length(next);
        next.mulAssign(clamp(s, FLOCK.speedRange[0], FLOCK.speedRange[1]).div(max(s, 0.001)));
        const forward = next.div(length(next));

        const sideways = a.sub(forward.mul(dot(a, forward)));
        const banked = normalize(vec3(0, 9.8, 0).add(sideways));
        const back = normalize(mix(banked, up.element(index).xyz, exp(dt.mul(-8))));

        const beat = hash(index.mul(uint(7)).add(uint(5)))
            .mul(0.3)
            .add(0.85)
            .mul(WINGS.beat * Math.PI * 2)
            .mul(alarm.mul(0.6).add(1));
        const phase = state.w.add(dt.mul(beat)).mod(Math.PI * 2);

        pos.element(index).assign(vec4(p.add(next.mul(dt)), phase));
        vel.element(index).assign(vec4(next, alarm));
        up.element(index).assign(vec4(back, rest));
    });

    return { pos, vel, up, grid, init, clear, scatter, fly, batch: new WgpuComputeBatch(renderer) };
}

/* splats */

/** A rotation from the frame whose columns are x, y, z (orthonormal): each component's size from the diagonal, its sign from the rest. */
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

const roll = (a: TslNode): TslNode => vec4(0, 0, sin(a.mul(0.5)), cos(a.mul(0.5)));
const yaw = (a: TslNode): TslNode => vec4(0, sin(a.mul(0.5)), 0, cos(a.mul(0.5)));

type Bird = { p: TslNode; v: TslNode; up: TslNode; phase: TslNode; alarm: TslNode };

function statelessBird(bird: TslNode): Bird {
    const h = (k: number) => hash(bird.mul(uint(7)).add(uint(k)));
    const z = h(1).mul(2).sub(1);
    const a0 = h(2).mul(Math.PI * 2);
    const r = h(3).pow(1 / 3);
    const at = (t: TslNode) => {
        // Inner birds wheel faster than outer ones, so the ball shears.
        const a = a0.add(t.mul(mix(0.32, 0.2, r)));
        const ring = sqrt(z.mul(z).oneMinus()).mul(r);
        const home = vec3(ring.mul(cos(a)), z.mul(r), ring.mul(sin(a)));
        const swirl = mx_noise_vec3(home.mul(1.4).add(vec3(0, t.mul(0.05), 0)));
        return look.roost.add(home.mul(vec3(32, 13, 32)).add(swirl.mul(vec3(15, 6, 15))));
    };
    const p = at(look.time).toVar();
    return {
        p,
        v: at(look.time.add(0.05)).sub(p).div(0.05),
        up: vec3(0, 1, 0),
        alarm: float(0),
        phase: look.time.mul(
            h(5)
                .mul(0.3)
                .add(0.85)
                .mul(WINGS.beat * Math.PI * 2),
        ),
    };
}

/** Seven splats a bird: body, head, tail, left arm and hand, right arm and hand. The last bird is the falcon. */
const PARTS = [
    { ...BIRD.parts.body, flank: 1 },
    { ...BIRD.parts.head, flank: 1 },
    { ...BIRD.parts.tail, flank: 1 },
    { ...BIRD.parts.arm, flank: -1 },
    { ...BIRD.parts.hand, flank: -1 },
    { ...BIRD.parts.arm, flank: 1 },
    { ...BIRD.parts.hand, flank: 1 },
];

function flockSplats(flock: Flock | null): SplatObject {
    const birds = FLOCK.birds;
    const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);
    const glowward = normalize(vec3(SUN_DIRECTION.x, 0.05, SUN_DIRECTION.z));

    const generateSplat = (index: TslNode) => {
        const which = index.div(uint(PARTS.length));
        const isFalcon = which.greaterThanEqual(uint(birds));
        const bird = min(which, uint(birds - 1));
        const part = index.mod(uint(PARTS.length));
        const pick = (value: (p: (typeof PARTS)[number]) => TslNode): TslNode =>
            PARTS.reduce<TslNode>(
                (picked, p, k) => (k === 0 ? value(p) : part.equal(uint(k)).select(value(p), picked)),
                float(0),
            );

        let state: Bird;
        if (flock) {
            const p = flock.pos.element(bird).toVar();
            const v = flock.vel.element(bird).toVar();
            state = { p: p.xyz, v: v.xyz, up: flock.up.element(bird).xyz, phase: p.w, alarm: v.w };
        } else {
            state = statelessBird(bird);
        }
        const p = isFalcon.select(look.falcon, state.p).toVar();
        const v = isFalcon.select(look.falconVelocity, state.v);
        const back = isFalcon.select(vec3(0, 1, 0), state.up);
        const phase = isFalcon.select(look.time.mul(4 * Math.PI), state.phase).toVar();

        const ahead = normalize(v.add(vec3(1e-4, 0, 0))).toVar();
        const right = normalize(cross(back, ahead).add(vec3(0, 1e-4, 0))).toVar();
        const frame = quatFromBasis(right, cross(ahead, right), ahead).toVar();
        const size = isFalcon.select(float(BIRD.size * BIRD.falcon), float(BIRD.size));

        // Flapping in bursts, gliding between with the wings held out, and hard when alarmed; a
        // falcon glides into its stoop.
        const h = hash(bird.mul(uint(7)).add(uint(6)));
        const gliding = smoothstep(-0.2, 0.2, sin(look.time.mul(0.9).add(h.mul(40))).sub(1 - 2 * WINGS.glide));
        const flapping = isFalcon.select(float(0.15), max(gliding.oneMinus(), state.alarm));

        const flank = pick((q) => float(q.flank)).toVar();
        const armAngle = flank.mul(sin(phase).mul(flapping).mul(WINGS.swing).add(WINGS.dihedral));
        const handAngle = armAngle.add(flank.mul(sin(phase.sub(WINGS.lag)).mul(flapping).mul(WINGS.fold)));
        const arm = GpuSplatMath.quatMul(frame, roll(armAngle)).toVar();
        const hand = GpuSplatMath.quatMul(GpuSplatMath.quatMul(frame, roll(handAngle)), yaw(flank.mul(BIRD.sweep))).toVar();

        const at = pick((q) => v3(q.at === 'shoulder' ? BIRD.shoulder : q.at)).mul(vec3(flank, 1, 1));
        const along = (q: TslNode, d: TslNode): TslNode => GpuSplatMath.quatRotate(q, vec3(flank.mul(d), 0, 0));
        const offset = GpuSplatMath.quatRotate(frame, at)
            .add(
                along(
                    arm,
                    pick((q) => float(q.arm)),
                ),
            )
            .add(
                along(
                    hand,
                    pick((q) => float(q.hand)),
                ),
            );
        const center = p.add(offset.mul(size)).toVar();
        const turn = (name: string) => (q: (typeof PARTS)[number]) => float(q.turn === name ? 1 : 0);
        const quaternion = pick(turn('hand'))
            .greaterThan(0.5)
            .select(hand, pick(turn('arm')).greaterThan(0.5).select(arm, frame));
        const sigma = pick((q) => v3(q.sigma));

        const isWing = part.greaterThanEqual(uint(3));
        const view = normalize(center.sub(look.eye));
        const through = pow(max(dot(view, glowward), 0), 5)
            .mul(PLUMAGE.through)
            .mul(isWing.select(float(1), float(0.3)));
        const rgb = isWing.select(v3(PLUMAGE.wing), v3(PLUMAGE.body)).add(v3(PLUMAGE.glow).mul(through));
        // Crisp, like the butterflies: opacity past 1 is a harder edge (lodInflate off), so each part is one clean shape.
        const opacity = isFalcon.select(look.falconSeen, float(1)).mul(isWing.select(float(2.4), float(1.8)));

        return GpuSplats.Splat(center, sigma.mul(size), quaternion, rgb, opacity, uint(index));
    };
    return SplatCollection.object({
        count: (birds + 1) * PARTS.length,
        generator: { generateSplat },
        params: { lodInflate: false },
    });
}

/* the flock, from the outside */

export type Birds = {
    object: SplatObject;
    roost: THREE.Vector3;
    update: (elapsed: number, dt: number, eye: THREE.Vector3, cursor: THREE.Ray | null) => void;
};

const falconPosition = new THREE.Vector3();
const falconVelocity = new THREE.Vector3();
const axis = new THREE.Vector3();

function setSim(t: number, dt: number): void {
    sim.dt.value = dt;
    roostAt(t, sim.roost.value as THREE.Vector3);
    const [nx, ny, nz] = GRID.dims;
    (sim.origin.value as THREE.Vector3)
        .copy(sim.roost.value as THREE.Vector3)
        .sub(scratch.set(nx, ny, nz).multiplyScalar(GRID.cell / 2));
    axis.set(WHEEL.lean * Math.sin(t / 17), 1, WHEEL.lean * Math.cos(t / 23)).normalize();
    const rate = WHEEL.rate * Math.sin((t / WHEEL.period) * Math.PI * 2 + 0.6);
    (sim.spin.value as THREE.Vector3).copy(axis).multiplyScalar(rate);
    (sim.drift.value as THREE.Vector3).set(t * SWIRL.drift, 0, -t * SWIRL.drift * 0.7);
    falconAt(t, sim.falcon.value as THREE.Vector3, falconVelocity);
}

export function initBirds(renderer: WebGPURenderer, compute: boolean): Birds {
    const flock = compute ? makeFlock(renderer) : null;
    let t = 0;

    if (flock) {
        setSim(0, STEP);
        flock.batch.add(flock.init, FLOCK.birds).submit();
        for (; t < WARMUP; t += STEP) step(flock, t, STEP);
    }

    const roost = roostAt(t, new THREE.Vector3());
    return {
        object: flockSplats(flock),
        roost,
        update(elapsed, dt, eye, cursor) {
            const along = sim.cursorAlong.value as THREE.Vector3;
            if (cursor) {
                // How fast it's swiping: how far the line through it turned since last frame.
                const turned = along.angleTo(cursor.direction) / Math.max(dt, 1e-3);
                const swipe = Math.min(turned / CURSOR.swipe, 1);
                const scare = (sim.cursorScare.value as number) * Math.exp(-dt / CURSOR.calm);
                sim.cursorScare.value = Math.max(scare, swipe);
                (sim.cursorFrom.value as THREE.Vector3).copy(cursor.origin);
                along.copy(cursor.direction);
            }
            const fade = (value: number, on: boolean, seconds: number) =>
                THREE.MathUtils.clamp(value + (on ? dt : -dt) / seconds, 0, 1);
            sim.cursorOn.value = fade(sim.cursorOn.value as number, cursor !== null, CURSOR.fade);
            if (flock) {
                step(flock, t, Math.min(dt, 1 / 20));
                t += dt;
            } else {
                t = elapsed + WARMUP;
            }
            look.time.value = t;
            roostAt(t, roost);
            (look.roost.value as THREE.Vector3).copy(roost);
            (look.eye.value as THREE.Vector3).copy(eye);
            look.falconSeen.value = falconAt(t, falconPosition, falconVelocity);
            (look.falcon.value as THREE.Vector3).copy(falconPosition);
            (look.falconVelocity.value as THREE.Vector3).copy(falconVelocity);
        },
    };
}

function step(flock: Flock, t: number, dt: number): void {
    setSim(t, dt);
    flock.batch
        .add(flock.clear, CELLS * CHANNELS)
        .add(flock.scatter, FLOCK.birds)
        .add(flock.fly, FLOCK.birds)
        .submit();
}
