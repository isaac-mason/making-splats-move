import { GpuSplatMath, GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';

const {
    clamp,
    cos,
    cross,
    dot,
    float,
    floor,
    hash,
    int,
    ivec2,
    length,
    max,
    mix,
    normalize,
    pow,
    sin,
    smoothstep,
    sqrt,
    textureLoad,
    uint,
    uniform,
    vec3,
    vec4,
} = TSL;

/* the scene's light */

export const SUN_DIRECTION = new THREE.Vector3(0.973, 0.156, -0.171).normalize();

/** Colours are sRGB-encoded, as splats blend. */
const SUN: Vec3 = [1.0, 0.82, 0.6];
const SKYLIGHT: Vec3 = [0.42, 0.48, 0.6];
const GLOW: Vec3 = [1.0, 0.74, 0.42];

type Vec3 = [number, number, number];

/* the head */

/** Top of the neck, where the head turns. They face -z, away from the camera; +x is their right. */
const PIVOT = new THREE.Vector3(0, 1.565, 0);

const HEAD = { center: [0, 0.1, 0.008] as Vec3, radii: [0.077, 0.1, 0.096] as Vec3, splats: 7000 };
const SKIN: Vec3 = [0.86, 0.64, 0.52];

/** Radians, two slow sines each so it never repeats. Positive yaw turns left (away from the sun), positive pitch looks up. */
const LOOK = {
    yaw: { rest: -0.12, sway: [0.3, 0.1], rate: [0.21, 0.53] },
    pitch: { rest: 0.06, sway: [0.05, 0.02], rate: [0.29, 0.71] },
};

/* the hair */

const HAIR = {
    /** Simulated guide strands, and points along each. */
    guides: 1200,
    points: 24,
    /** Root to tip, metres. */
    length: [0.48, 0.6],
    /** How far a root lifts off the scalp rather than lying along it. */
    lift: 0.18,
    /** Metres at most: each guide keeps its own distance off the head, for body instead of a painted-on cap. */
    volume: 0.022,
    /** Stiffness near the root, fading along the strand to a tip that goes where it's blown. */
    stiffness: 0.45,
    /** How much of the sliding along the head is lost to friction where hair rests on it. */
    friction: 0.3,
    /** Damping of the follow-the-leader solve: 1 is undamped, less loses the stretch's energy. */
    ftlDamping: 0.9,
    /** Child strands drawn per guide, and splats along each. */
    children: 16,
    segments: 18,
    /** A splat's place along the strand goes as its index to this power: crowded at the root, spread at the tip. */
    crowd: 1.45,
    /** How far a child sits from its guide at the root, metres, and how tight it's drawn at the tip. */
    spread: 0.0075,
    clump: 0.38,
    /** Children that wander off their lock, and how far. */
    flyaways: 0.06,
    frizz: 0.012,
    /** A soft wave through each lock: wavelength and size, metres. */
    wave: [0.09, 0.005],
    /** A strand's width (a splat's standard deviation), metres, and how much it widens with distance. */
    width: 0.00045,
    widenFrom: 1.0,
    widen: 4,
    opacity: 0.75,
};

/** sRGB albedos: blonde from honey to wheat, ash in some locks, deeper underneath, sun-bleached at the ends. */
const BLONDE = {
    honey: [0.74, 0.55, 0.31] as Vec3,
    wheat: [0.89, 0.77, 0.53] as Vec3,
    ash: [0.8, 0.73, 0.58] as Vec3,
    bleached: [0.96, 0.9, 0.74] as Vec3,
    under: [0.5, 0.36, 0.2] as Vec3,
};

/* the wind */

const WIND = {
    /** The way it blows: off the sea from the right, a little from ahead, lifting up the cliff. */
    toward: new THREE.Vector3(-0.97, 0.12, 0.18).normalize(),
    /** Its speed, m/s, before the gusts. */
    speed: 4.4,
    /** How fast gusts travel past, m/s, so they reach the far side of the head a moment later. */
    travel: 4,
    /** 1/s at the tip (the root's is a third). Low, so hair has weight and lags a gust. */
    drag: 1.8,
    /** Eddies, as a fraction of the wind, their size, metres, and how fast they churn. */
    turbulence: 0.28,
    eddy: 0.3,
    churn: 0.5,
};

/* the guides, simulated on the CPU */

const G = HAIR.guides;
const N = HAIR.points;
/** Fixed, because uneven steps make follow-the-leader jitter; drawn blended between the last two steps. */
const STEP = 1 / 60;
const MAX_STEPS = 3;
const GRAVITY = 9.81;
/** Where along a strand the wind is sampled; points between take it from the nearest two. */
const WIND_SAMPLES = [2, 7, 12, 17, N - 1];

export type Strands = {
    points: Float32Array;
    before: Float32Array;
    drawn: Float32Array;
    velocity: Float32Array;
    /** The two pinned points of each guide, root and the one after it, relative to the pivot in the head's frame. */
    roots: Float32Array;
    /** Per guide: how far off the body it lies, how strongly the wind takes it, and its eddies' phase. */
    margin: Float32Array;
    drag: Float32Array;
    phase: Float32Array;
    head: THREE.Quaternion;
    headBefore: THREE.Quaternion;
    headDrawn: THREE.Quaternion;
    time: number;
    carry: number;
};

function rand(i: number, salt: number): number {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
}

const euler = new THREE.Euler(0, 0, 0, 'YXZ');

function headPose(t: number, out: THREE.Quaternion): THREE.Quaternion {
    const swing = (axis: typeof LOOK.yaw, phase: number) =>
        axis.rest + axis.sway[0] * Math.sin(axis.rate[0] * t + phase) + axis.sway[1] * Math.sin(axis.rate[1] * t + phase * 2.3);
    euler.set(swing(LOOK.pitch, 1), swing(LOOK.yaw, 0.6), 0);
    return out.setFromEuler(euler);
}

function onScalp(dir: THREE.Vector3): boolean {
    // Front is -z: the forehead's hairline is high, the temples' at the ear tops, the nape's low.
    const front = -dir.z;
    const back = mix1(-0.55, -0.08, smooth(-0.45, -0.1, front));
    return dir.y > mix1(back, 0.38, smooth(0.12, 0.4, front));
}

const mix1 = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
};

function plantRoots(strands: Strands) {
    const dir = new THREE.Vector3();
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const comb = new THREE.Vector3();
    const [rx, ry, rz] = HEAD.radii;
    const golden = Math.PI * (3 - Math.sqrt(5));

    let total = G * 2;
    for (;;) {
        let kept = 0;
        for (let i = 0; i < total; i++) if (onScalp(spiral(dir, i, total, golden))) kept++;
        if (kept >= G) break;
        total = Math.ceil((total * G) / kept) + 1;
    }

    let g = 0;
    for (let i = 0; i < total && g < G; i++) {
        if (!onScalp(spiral(dir, i, total, golden))) continue;
        const scale = 1 / Math.hypot(dir.x / rx, dir.y / ry, dir.z / rz);
        point.copy(dir).multiplyScalar(scale);
        normal.set(point.x / rx ** 2, point.y / ry ** 2, point.z / rz ** 2).normalize();
        point.add(new THREE.Vector3(...HEAD.center));

        const side = Math.sign(dir.x || 1) * smooth(0, 0.3, Math.abs(dir.x));
        comb.set(side * 0.7, -1, 0.15);
        comb.addScaledVector(normal, -comb.dot(normal)).normalize();
        comb.multiplyScalar(1 - HAIR.lift)
            .addScaledVector(normal, HAIR.lift)
            .normalize();

        const length = mix1(HAIR.length[0], HAIR.length[1], rand(g, 1));
        const seg = length / (N - 1);
        strands.roots.set(
            [point.x, point.y, point.z, point.x + comb.x * seg, point.y + comb.y * seg, point.z + comb.z * seg],
            g * 6,
        );
        for (let j = 0; j < N; j++) strands.points[(g * N + j) * 4 + 3] = seg;
        strands.margin[g] = 0.003 + HAIR.volume * rand(g, 2) ** 1.5;
        strands.drag[g] = mix1(0.7, 1.25, rand(g, 3));
        strands.phase[g] = point.x * 7 + point.y * 5 - point.z * 6 + rand(g, 4) * 0.5;
        g++;
    }
}

function spiral(out: THREE.Vector3, i: number, count: number, golden: number): THREE.Vector3 {
    const y = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(1 - y * y);
    return out.set(Math.cos(i * golden) * ring, y, Math.sin(i * golden) * ring);
}

const R = new Float64Array(9);
const _m = new THREE.Matrix4();

const headAt = new Float64Array(3);

function poseHead(q: THREE.Quaternion) {
    const e = _m.makeRotationFromQuaternion(q).elements;
    R.set([e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]);
    const [x, y, z] = HEAD.center;
    headAt[0] = PIVOT.x + R[0] * x + R[1] * y + R[2] * z;
    headAt[1] = PIVOT.y + R[3] * x + R[4] * y + R[5] * z;
    headAt[2] = PIVOT.z + R[6] * x + R[7] * y + R[8] * z;
}

/** Pushes (x, y, z) `margin` out of the head and loses some slide along the scalp since (px, py, pz). Solved as a sphere in the ellipsoid's squashed space: not the nearest point, but smooth and close. */
function collide(x: number, y: number, z: number, px: number, py: number, pz: number, margin: number, out: Float64Array) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    const wx = x - headAt[0];
    const wy = y - headAt[1];
    const wz = z - headAt[2];
    const reach = HEAD.radii[2] + HEAD.radii[1] + margin;
    if (wx * wx + wy * wy + wz * wz > reach * reach) return;
    let dx = R[0] * wx + R[3] * wy + R[6] * wz;
    let dy = R[1] * wx + R[4] * wy + R[7] * wz;
    let dz = R[2] * wx + R[5] * wy + R[8] * wz;
    const ax = HEAD.radii[0] + margin;
    const ay = HEAD.radii[1] + margin;
    const az = HEAD.radii[2] + margin;
    const u = Math.sqrt((dx * dx) / (ax * ax) + (dy * dy) / (ay * ay) + (dz * dz) / (az * az));
    if (u >= 1 || u < 1e-6) return;
    dx /= u;
    dy /= u;
    dz /= u;
    let nx = dx / (ax * ax);
    let ny = dy / (ay * ay);
    let nz = dz / (az * az);
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    x = headAt[0] + R[0] * dx + R[1] * dy + R[2] * dz;
    y = headAt[1] + R[3] * dx + R[4] * dy + R[5] * dz;
    z = headAt[2] + R[6] * dx + R[7] * dy + R[8] * dz;
    const mx = R[0] * nx + R[1] * ny + R[2] * nz;
    const my = R[3] * nx + R[4] * ny + R[5] * nz;
    const mz = R[6] * nx + R[7] * ny + R[8] * nz;
    const sx = x - px;
    const sy = y - py;
    const sz = z - pz;
    const along = sx * mx + sy * my + sz * mz;
    out[0] = x - (sx - mx * along) * HAIR.friction;
    out[1] = y - (sy - my * along) * HAIR.friction;
    out[2] = z - (sz - mz * along) * HAIR.friction;
}

function gustiness(t: number): number {
    return 0.85 + 0.36 * Math.sin(0.41 * t) + 0.2 * Math.sin(1.13 * t + 1.7);
}

function windAt(x: number, y: number, z: number, t: number, phase: number, out: Float64Array, o: number) {
    const w = WIND.toward;
    const along = x * w.x + y * w.y + z * w.z;
    const speed = WIND.speed * gustiness(t - along / WIND.travel);
    const ax = (x - w.x * WIND.speed * t) / WIND.eddy;
    const ay = (y - w.y * WIND.speed * t) / WIND.eddy;
    const az = (z - w.z * WIND.speed * t) / WIND.eddy;
    const e = WIND.turbulence * speed;
    t *= WIND.churn;
    out[o] = w.x * speed + e * (Math.sin(ay * 1.3 + az * 0.9 + t * 1.9 + phase) + 0.5 * Math.sin(ax * 2.1 - ay * 1.6 + t * 3.1));
    out[o + 1] =
        w.y * speed + e * (Math.sin(ax * 1.1 + az * 1.4 + t * 2.3 + phase * 1.3) + 0.5 * Math.sin(ay * 2.4 + ax * 0.7 + t * 3.7));
    out[o + 2] =
        w.z * speed + e * (Math.sin(ax * 1.6 - ay * 1.2 + t * 1.6 + phase * 0.7) + 0.5 * Math.sin(az * 2.2 + ay * 0.8 + t * 2.9));
}

const px = new Float64Array(N);
const py = new Float64Array(N);
const pz = new Float64Array(N);
const fix = new Float64Array(N * 3);
const air = new Float64Array(N * 3);
const hit = new Float64Array(3);

function windAlong(P: Float32Array, base: number, t: number, phase: number) {
    for (const j of WIND_SAMPLES) {
        const p = (base + j) * 4;
        windAt(P[p], P[p + 1], P[p + 2], t, phase, air, j * 3);
    }
    for (let k = 0; k + 1 < WIND_SAMPLES.length; k++) {
        const a = WIND_SAMPLES[k];
        const b = WIND_SAMPLES[k + 1];
        for (let j = a + 1; j < b; j++) {
            const f = (j - a) / (b - a);
            for (let c = 0; c < 3; c++) air[j * 3 + c] = air[a * 3 + c] + (air[b * 3 + c] - air[a * 3 + c]) * f;
        }
    }
}

function step(strands: Strands, dt: number) {
    strands.time += dt;
    const t = strands.time;
    headPose(t, strands.head);
    poseHead(strands.head);
    const { points: P, velocity: V, roots } = strands;
    const damp = Math.exp(-0.4 * dt);

    for (let g = 0; g < G; g++) {
        const base = g * N;
        const seg = P[base * 4 + 3];
        const margin = strands.margin[g];
        const drag = WIND.drag * strands.drag[g];

        for (let j = 0; j < 2; j++) {
            const o = g * 6 + j * 3;
            const lx = roots[o];
            const ly = roots[o + 1];
            const lz = roots[o + 2];
            px[j] = PIVOT.x + R[0] * lx + R[1] * ly + R[2] * lz;
            py[j] = PIVOT.y + R[3] * lx + R[4] * ly + R[5] * lz;
            pz[j] = PIVOT.z + R[6] * lx + R[7] * ly + R[8] * lz;
        }

        windAlong(P, base, t, strands.phase[g]);
        for (let j = 2; j < N; j++) {
            const p = (base + j) * 4;
            const v = (base + j) * 3;
            const k = drag * (0.35 + (0.65 * j) / (N - 1));
            V[v] = (V[v] + k * (air[j * 3] - V[v]) * dt) * damp;
            V[v + 1] = (V[v + 1] + (k * (air[j * 3 + 1] - V[v + 1]) - GRAVITY) * dt) * damp;
            V[v + 2] = (V[v + 2] + k * (air[j * 3 + 2] - V[v + 2]) * dt) * damp;
            px[j] = P[p] + V[v] * dt;
            py[j] = P[p + 1] + V[v + 1] * dt;
            pz[j] = P[p + 2] + V[v + 2] * dt;
        }

        // Follow-the-leader (Müller et al. 2012, "Fast Simulation of Inextensible Hair and Fur"); re-fixing the length after the collision keeps hair from stretching round the head.
        for (let j = 2; j < N; j++) {
            const along = j / (N - 1);
            const stiff = HAIR.stiffness * (1 - along) * (1 - along) * (1 - along);
            let dx = px[j - 1] - px[j - 2];
            let dy = py[j - 1] - py[j - 2];
            let dz = pz[j - 1] - pz[j - 2];
            const dl = seg / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
            const wx = px[j] + (px[j - 1] + dx * dl - px[j]) * stiff;
            const wy = py[j] + (py[j - 1] + dy * dl - py[j]) * stiff;
            const wz = pz[j] + (pz[j - 1] + dz * dl - pz[j]) * stiff;

            dx = wx - px[j - 1];
            dy = wy - py[j - 1];
            dz = wz - pz[j - 1];
            let l = seg / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
            // Only the length correction feeds the damping: damping the collision push kicks resting hair every frame.
            fix[j * 3] = dx * l - dx;
            fix[j * 3 + 1] = dy * l - dy;
            fix[j * 3 + 2] = dz * l - dz;
            const p = (base + j) * 4;
            collide(px[j - 1] + dx * l, py[j - 1] + dy * l, pz[j - 1] + dz * l, P[p], P[p + 1], P[p + 2], margin, hit);
            dx = hit[0] - px[j - 1];
            dy = hit[1] - py[j - 1];
            dz = hit[2] - pz[j - 1];
            l = seg / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
            const cx = px[j - 1] + dx * l;
            const cy = py[j - 1] + dy * l;
            const cz = pz[j - 1] + dz * l;
            px[j] = cx;
            py[j] = cy;
            pz[j] = cz;
        }

        for (let j = 0; j < N; j++) {
            const p = (base + j) * 4;
            const v = (base + j) * 3;
            if (j >= 2) {
                const next = j + 1 < N ? HAIR.ftlDamping / dt : 0;
                const n3 = (j + 1) * 3;
                V[v] = (px[j] - P[p]) / dt - (next ? next * fix[n3] : 0);
                V[v + 1] = (py[j] - P[p + 1]) / dt - (next ? next * fix[n3 + 1] : 0);
                V[v + 2] = (pz[j] - P[p + 2]) / dt - (next ? next * fix[n3 + 2] : 0);
            }
            P[p] = px[j];
            P[p + 1] = py[j];
            P[p + 2] = pz[j];
        }
    }
}

export function createStrands(settle = 2): Strands {
    const strands: Strands = {
        points: new Float32Array(G * N * 4),
        velocity: new Float32Array(G * N * 3),
        roots: new Float32Array(G * 6),
        margin: new Float32Array(G),
        drag: new Float32Array(G),
        phase: new Float32Array(G),
        before: new Float32Array(G * N * 4),
        drawn: new Float32Array(G * N * 4),
        head: new THREE.Quaternion(),
        headBefore: new THREE.Quaternion(),
        headDrawn: new THREE.Quaternion(),
        time: -settle,
        carry: 0,
    };
    plantRoots(strands);

    headPose(strands.time, strands.head);
    poseHead(strands.head);
    const { points: P, roots } = strands;
    const dir = new THREE.Vector3();
    for (let g = 0; g < G; g++) {
        const base = g * N;
        const seg = P[base * 4 + 3];
        for (let j = 0; j < 2; j++) {
            const o = g * 6 + j * 3;
            const [lx, ly, lz] = [roots[o], roots[o + 1], roots[o + 2]];
            P[(base + j) * 4] = PIVOT.x + R[0] * lx + R[1] * ly + R[2] * lz;
            P[(base + j) * 4 + 1] = PIVOT.y + R[3] * lx + R[4] * ly + R[5] * lz;
            P[(base + j) * 4 + 2] = PIVOT.z + R[6] * lx + R[7] * ly + R[8] * lz;
        }
        const b = base * 4;
        dir.set(P[b + 4] - P[b], P[b + 5] - P[b + 1], P[b + 6] - P[b + 2]).normalize();
        for (let j = 2; j < N; j++) {
            dir.lerp(new THREE.Vector3(0, -1, 0), 0.3).normalize();
            const p = (base + j) * 4;
            collide(
                P[p - 4] + dir.x * seg,
                P[p - 3] + dir.y * seg,
                P[p - 2] + dir.z * seg,
                P[p - 4],
                P[p - 3],
                P[p - 2],
                strands.margin[g],
                hit,
            );
            P[p] = hit[0];
            P[p + 1] = hit[1];
            P[p + 2] = hit[2];
        }
    }
    for (let i = 0; i < settle / STEP; i++) step(strands, STEP);
    strands.before.set(strands.points);
    strands.drawn.set(strands.points);
    strands.headBefore.copy(strands.head);
    strands.headDrawn.copy(strands.head);
    return strands;
}

export function advanceStrands(strands: Strands, dt: number) {
    strands.carry += dt;
    let steps = 0;
    while (strands.carry >= STEP && steps < MAX_STEPS) {
        strands.before.set(strands.points);
        strands.headBefore.copy(strands.head);
        step(strands, STEP);
        strands.carry -= STEP;
        steps++;
    }
    // Too slow to keep up: let the hair run slow rather than fall further behind.
    strands.carry = Math.min(strands.carry, STEP);
    const f = strands.carry / STEP;
    const { before, points, drawn } = strands;
    for (let i = 0; i < drawn.length; i++) drawn[i] = before[i] + (points[i] - before[i]) * f;
    strands.headDrawn.slerpQuaternions(strands.headBefore, strands.head, f);
}

/* uniforms, set once a frame */

const eye = uniform(new THREE.Vector3());
const headTurn = uniform(new THREE.Vector4(0, 0, 0, 1));
const headCenter = uniform(new THREE.Vector3());

let guideMap: THREE.DataTexture;

/* helpers, on the GPU */

const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);
const sun = v3([SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z]);

/** Four independent numbers in [0, 1) for item `id`, from three's PCG hash; each `salt` a separate stream. */
const hash4 = (id: TslNode, salt: number): TslNode => {
    const base = uint(id)
        .mul(uint(16))
        .add(uint(salt * 4));
    return vec4(hash(base), hash(base.add(uint(1))), hash(base.add(uint(2))), hash(base.add(uint(3))));
};

const alignY = (dir: TslNode): TslNode => normalize(vec4(cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));

function generated(count: number, body: (index: TslNode) => TslNode, hard = false): SplatObject {
    return SplatCollection.object({
        count,
        generator: { generateSplat: body },
        ...(hard ? { params: { lodInflate: false } } : {}),
    });
}

/** The head's shadow on hair streaming clear of it only: on the head itself the edge would run as a line down the back. */
function headShadow(p: TslNode): TslNode {
    const toHead = headCenter.sub(p);
    const ahead = dot(toHead, sun);
    const miss = length(toHead.sub(sun.mul(ahead)));
    const clear = smoothstep(0.11, 0.2, length(toHead));
    const behind = ahead.greaterThan(0).select(smoothstep(0.11, 0.04, miss), float(0));
    return float(1).sub(behind.mul(clear).mul(0.5));
}

/* the hair, on the GPU */

function alongGuide(guide: TslNode, s: TslNode): { point: TslNode; tangent: TslNode; seg: TslNode } {
    const u = s.mul(N - 1);
    const i = floor(u);
    const f = u.sub(i).toVar();
    const at = (k: number) => textureLoad(guideMap, ivec2(int(clamp(i.add(k), 0, N - 1)), int(guide)));
    const p1 = at(0).toVar();
    const p0 = at(-1).xyz;
    const p2 = at(1).xyz;
    const p3 = at(2).xyz;
    const a = p1.xyz.mul(2);
    const b = p2.sub(p0);
    const c = p0.mul(2).sub(p1.xyz.mul(5)).add(p2.mul(4)).sub(p3);
    const d = p1.xyz.mul(3).sub(p0).sub(p2.mul(3)).add(p3);
    const point = a
        .add(b.mul(f))
        .add(c.mul(f.mul(f)))
        .add(d.mul(f.mul(f).mul(f)))
        .mul(0.5);
    const tangent = normalize(b.add(c.mul(f.mul(2))).add(d.mul(f.mul(f).mul(3))));
    return { point, tangent, seg: p1.w };
}

function hair(): SplatObject {
    const { children, segments } = HAIR;

    return generated(G * children * segments, (index) => {
        const child = index.div(uint(segments));
        const guide = child.div(uint(children));
        const k = float(index.mod(uint(segments)));

        const a = hash4(child, 0).toVar();
        const b = hash4(child, 1).toVar();
        const lock = hash4(guide, 2).toVar();

        const reach = mix(0.7, 1, pow(a.x, 0.5));
        const u = k.add(0.5).div(segments);
        const t = pow(u, HAIR.crowd).toVar();
        const spacing = pow(u, HAIR.crowd - 1).mul(HAIR.crowd / segments);
        const s = t.mul(reach).toVar();
        const loose = a.y.lessThan(HAIR.flyaways).select(float(1), float(0)).toVar();

        const { point, tangent, seg } = alongGuide(guide, s);
        const T = tangent.toVar();

        const away = point.sub(headCenter).toVar();
        const out = normalize(away.sub(T.mul(dot(away, T)))).toVar();
        const across = cross(T, out);

        const angle = a.z.mul(Math.PI * 2);
        const radius = sqrt(a.w).mul(HAIR.spread);
        const outward = cos(angle).mul(0.6).add(0.4).toVar();
        const gather = mix(1, HAIR.clump, smoothstep(0.15, 0.95, s)).mul(s.mul(1.2).add(1));
        const strays = loose.mul(s).mul(HAIR.frizz);
        const offsetOut = outward
            .mul(radius)
            .mul(gather)
            .add(strays.mul(sin(s.mul(41).add(b.x.mul(6.3)))));
        const offsetAcross = sin(angle)
            .mul(radius)
            .mul(gather)
            .add(strays.mul(cos(s.mul(37).add(b.y.mul(6.3)))));

        const length0 = seg.mul(N - 1);
        const wavePhase = s
            .mul(length0)
            .mul((Math.PI * 2) / HAIR.wave[0])
            .add(lock.x.mul(6.3));
        const wave = smoothstep(0.2, 0.8, s).mul(HAIR.wave[1]);

        const center = point
            .add(out.mul(offsetOut.add(sin(wavePhase).mul(wave))))
            .add(across.mul(offsetAcross.add(cos(wavePhase).mul(wave).mul(0.5))))
            .toVar();

        const distance = length(center.sub(eye));
        const width = float(HAIR.width).mul(clamp(distance.div(HAIR.widenFrom), 1, HAIR.widen));
        const taper = mix(1, 0.45, smoothstep(0.6, 1, t));
        const scales = vec3(width.mul(taper), length0.mul(reach).mul(spacing).mul(0.5), width.mul(taper));

        const tone = mix(lock.y, b.z, 0.35);
        let base = mix(v3(BLONDE.honey), v3(BLONDE.wheat), tone);
        base = mix(base, v3(BLONDE.ash), lock.z.mul(lock.z).mul(0.6));
        const depth = smoothstep(0.8, -0.2, outward).mul(0.35);
        base = mix(base, v3(BLONDE.under), depth.add(smoothstep(0.12, 0, s).mul(0.35)));
        base = mix(base, v3(BLONDE.bleached), smoothstep(0.45, 1, s).mul(0.5)).toVar();

        // Kajiya-Kay: lit by the sun's angle to the strand; shade comes from the rest of the hair.
        const thin = max(smoothstep(0.55, 1, s).mul(0.6), loose);
        const facing = dot(normalize(away), sun).mul(0.5).add(0.5);
        const mass = mix(0.45, 1, facing).mul(mix(0.75, 1.05, outward.mul(0.5).add(0.5)));
        const shadow = mix(mass, 1, thin).mul(headShadow(center)).toVar();

        const along = dot(T, sun);
        const diffuse = sqrt(max(float(1).sub(along.mul(along)), 0));

        const view = normalize(eye.sub(center)).toVar();
        const half = normalize(sun.add(view));
        const glint = (shift: number, sharpness: number) => {
            const tilted = normalize(T.add(out.mul(shift)));
            const c = dot(tilted, half);
            return pow(sqrt(max(float(1).sub(c.mul(c)), 0)), sharpness);
        };
        const sparkle = mix(0.4, 1, b.w);
        const primary = glint(-0.1, 90).mul(0.45).mul(sparkle);
        const secondary = glint(0.14, 22).mul(0.5).mul(sparkle);

        const towards = max(dot(view.negate(), sun), 0);
        const through = pow(towards, 5)
            .mul(1.3)
            .add(pow(towards, 2).mul(0.12))
            .mul(mix(0.18, 1, thin));

        const ambient = mix(0.45, 1, outward.mul(0.5).add(0.5)).mul(smoothstep(0, 0.3, s).mul(0.4).add(0.6));
        const scattered = v3(GLOW).mul(float(1).sub(shadow).mul(0.22));
        const rgb = base
            .mul(
                v3(SUN)
                    .mul(diffuse.mul(shadow))
                    .add(v3(SKYLIGHT).mul(ambient.mul(0.5)))
                    .add(scattered),
            )
            .add(
                v3(SUN)
                    .mul(primary.add(base.mul(secondary)))
                    .mul(shadow),
            )
            .add(base.mul(v3(GLOW)).mul(through.mul(headShadow(center))));

        const opacity = mix(HAIR.opacity, HAIR.opacity * 0.6, loose).mul(mix(1, 0.3, smoothstep(0.75, 1, t)));
        return GpuSplats.Splat(center, scales, alignY(T), rgb, opacity, uint(index));
    });
}

/* the head, on the GPU */

function head(): SplatObject {
    const n = HEAD.splats;
    const [rx, ry, rz] = HEAD.radii;
    // An ellipsoid's area (Thomsen's), shared out between the splats.
    const p = 1.6;
    const area = 4 * Math.PI * (((rx * ry) ** p + (rx * rz) ** p + (ry * rz) ** p) / 3) ** (1 / p);
    const size = Math.sqrt(area / n) * 0.7;
    const golden = Math.PI * (3 - Math.sqrt(5));

    return generated(
        n,
        (index) => {
            const i = float(index);
            const y = i
                .add(0.5)
                .mul(-2 / n)
                .add(1);
            const ring = sqrt(max(float(1).sub(y.mul(y)), 0));
            const phi = i.mul(golden);
            const dir = vec3(cos(phi).mul(ring), y, sin(phi).mul(ring));
            const local = dir.mul(v3(HEAD.radii)).add(v3(HEAD.center));
            const center = v3([PIVOT.x, PIVOT.y, PIVOT.z]).add(GpuSplatMath.quatRotate(headTurn, local));
            const normal = GpuSplatMath.quatRotate(headTurn, normalize(dir.div(v3(HEAD.radii)))).toVar();
            const lit = max(dot(normal, sun), 0);
            const sky = normal.y.mul(0.3).add(0.6);
            const rgb = v3(SKIN).mul(
                v3(SUN)
                    .mul(lit.mul(0.9))
                    .add(v3(SKYLIGHT).mul(sky.mul(0.55))),
            );
            return GpuSplats.Splat(center, vec3(size, size * 0.25, size), alignY(normal), rgb, float(1.5), uint(index));
        },
        true,
    );
}

/* setup and per frame */

export type Hair = { objects: SplatObject[]; strands: Strands };

export function initHair(): Hair {
    const strands = createStrands();
    guideMap = new THREE.DataTexture(strands.drawn, N, G, THREE.RGBAFormat, THREE.FloatType);
    guideMap.minFilter = guideMap.magFilter = THREE.NearestFilter;
    guideMap.needsUpdate = true;
    return { objects: [head(), hair()], strands };
}

const _center = new THREE.Vector3();

export function updateHair(state: Hair, dt: number, camera: THREE.Camera): void {
    advanceStrands(state.strands, dt);
    guideMap.needsUpdate = true;
    eye.value.copy(camera.position);
    const q = state.strands.headDrawn;
    headTurn.value.set(q.x, q.y, q.z, q.w);
    headCenter.value.copy(
        _center
            .set(...HEAD.center)
            .applyQuaternion(q)
            .add(PIVOT),
    );
}
