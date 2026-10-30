/**
 * The wind, drawn: thin white ribbons zipping downwind over the sea, the way
 * Wind Waker and Breath of the Wild show a breeze. Every splat's worked out from
 * its index and the time: nothing's simulated or stored.
 *
 * Each ribbon runs along a path: downwind, a gentle S-curve side to side, and now
 * and then a loop-de-loop somewhere along it, after which it carries on. The
 * ribbon's a few metres of that path, travelling along it at the wind's speed,
 * head leading and tail following; it fades in as it sets off and out before it
 * stops. It's a chain of thin splats, tapering to nothing at both ends, a little
 * see-through. Each life it starts somewhere new, in a box round the camera that
 * wraps, a steady height over the water.
 *
 * Sections: settings · a path · splats.
 */

import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { SEA } from './waves';

const { clamp, cos, cross, dot, float, floor, fract, hash, max, mix, normalize, sin, smoothstep, uint, uniform, vec3, vec4 } =
    TSL;

/* settings */

/**
 * The ribbons: how many, of how many splats each; the box round the camera they
 * start in (metres across), and from and to this high over the sea; how long one
 * lives (seconds, give or take) and how fast it travels (m/s); how long it is
 * (metres); how far it's turned off the wind (radians either way); its S-curve
 * (how far side to side, metres, and how long a wave of it, metres; and up and
 * down, likewise, so it rises and dips as it goes); how often
 * one loops, how big the loop is (radius, metres) and how far along the path it
 * comes (metres); how thick (metres, a standard deviation, and never under this
 * much of the distance, so it's a hairline far off), how white and how solid.
 */
const RIBBONS = {
    count: 16,
    splats: 64,
    box: 56,
    height: [0.6, 9],
    life: [2.4, 3.4],
    speed: 9,
    length: [3.5, 6],
    turn: 0.25,
    curve: { side: [0.15, 0.6], every: [7, 12], rise: [0.3, 1.4], riseEvery: [8, 16] },
    loop: { share: 0.35, radius: [0.45, 0.8], at: [6, 14] },
    thick: 0.014,
    least: 0.0007,
    white: [0.96, 0.98, 1],
    solid: 0.9,
};

/** How it fades: in over this share of its life, out over the last this share; and away within this near the eye (metres). */
const FADE = { in: 0.15, out: 0.25, near: [5, 10] };

const time = uniform(0);
const eye = uniform(new THREE.Vector3());

/* a path */

const downwindAngle = SEA.towards;

/**
 * Where a ribbon's path is `s` metres along it, from where it starts: along its
 * way `dir`, curving side to side across `side`, and, if it loops, round a loop
 * of radius `radius` at `loopAt`, turning across `facing` (the way up the screen
 * from here, so the loop's seen face on), after which it carries on.
 */
function path(
    s: TslNode,
    dir: TslNode,
    side: TslNode,
    curve: TslNode,
    every: TslNode,
    phase: TslNode,
    loopAt: TslNode,
    radius: TslNode,
    facing: TslNode,
    rise: TslNode,
    riseEvery: TslNode,
) {
    // Round the loop by its angle: none before it, a whole turn after it.
    const a = clamp(s.sub(loopAt).div(radius), 0, Math.PI * 2);
    const forward = s.sub(radius.mul(a)).add(radius.mul(sin(a)));
    const swaying = side.mul(
        sin(
            s
                .div(every)
                .mul(Math.PI * 2)
                .add(phase),
        ).mul(curve),
    );
    const rising = vec3(
        0,
        sin(
            s
                .div(riseEvery)
                .mul(Math.PI * 2)
                .add(phase.mul(1.7)),
        ).mul(rise),
        0,
    );
    return dir
        .mul(forward)
        .add(swaying)
        .add(rising)
        .add(facing.mul(radius.mul(cos(a).oneMinus())));
}

/** A rotation taking +x onto `dir`. */
const xTo = (dir: TslNode): TslNode => {
    const d = normalize(dir);
    return normalize(vec4(cross(vec3(1, 0, 0), d), dot(vec3(1, 0, 0), d).add(1.0001)));
};

/* splats */

function generateSplat(index: TslNode) {
    const ribbon = index.div(uint(RIBBONS.splats));
    const k = float(index.mod(uint(RIBBONS.splats)));
    const h = (n: number, salt: TslNode = float(0)) =>
        hash(
            ribbon
                .mul(uint(977))
                .add(uint(n))
                .add(uint(salt.mul(131))),
        );

    // This life of the ribbon: its own length of life, which life it's on, and how far in.
    const life = mix(RIBBONS.life[0], RIBBONS.life[1], h(1));
    const lived = time.div(life).add(h(2));
    const which = floor(lived);
    const f = fract(lived).toVar();
    const r = (n: number) => h(n, which);

    // Where it starts this life: somewhere in the box, wrapped round the eye.
    const offset = vec3(r(3).sub(0.5).mul(RIBBONS.box), 0, r(5).sub(0.5).mul(RIBBONS.box)).sub(vec3(eye.x, 0, eye.z));
    const start = vec3(
        fract(offset.x.div(RIBBONS.box).add(0.5)).sub(0.5).mul(RIBBONS.box).add(eye.x),
        mix(RIBBONS.height[0], RIBBONS.height[1], r(4)),
        fract(offset.z.div(RIBBONS.box).add(0.5)).sub(0.5).mul(RIBBONS.box).add(eye.z),
    ).toVar();

    // Its path: downwind give or take, curving, and maybe a loop.
    const angle = r(6)
        .sub(0.5)
        .mul(2 * RIBBONS.turn)
        .add(downwindAngle);
    const dir = vec3(cos(angle), 0, sin(angle)).toVar();
    const side = vec3(sin(angle).negate(), 0, cos(angle));
    const curve = mix(RIBBONS.curve.side[0], RIBBONS.curve.side[1], r(7));
    const every = mix(RIBBONS.curve.every[0], RIBBONS.curve.every[1], r(8));
    const phase = r(9).mul(Math.PI * 2);
    const loops = r(10).lessThan(RIBBONS.loop.share);
    const loopAt = loops.select(mix(RIBBONS.loop.at[0], RIBBONS.loop.at[1], r(11)), float(1e4));
    const radius = mix(RIBBONS.loop.radius[0], RIBBONS.loop.radius[1], r(12));
    const toEye = normalize(eye.sub(start));
    const facing = normalize(cross(dir, toEye).add(vec3(0, 1e-3, 0))).toVar();
    const rise = mix(RIBBONS.curve.rise[0], RIBBONS.curve.rise[1], r(14));
    const riseEvery = mix(RIBBONS.curve.riseEvery[0], RIBBONS.curve.riseEvery[1], r(15));
    const at = (s: TslNode) => start.add(path(s, dir, side, curve, every, phase, loopAt, radius, facing, rise, riseEvery));

    // The ribbon: its head travelling along the path, its tail a length behind (not before the start).
    const length = mix(RIBBONS.length[0], RIBBONS.length[1], r(13));
    const head = f.mul(life).mul(RIBBONS.speed);
    const tail = max(head.sub(length), 0);
    const u = k.add(0.5).div(RIBBONS.splats);
    const s = mix(tail, head, u).toVar();
    const step = head.sub(tail).div(RIBBONS.splats).max(1e-4);
    const here = at(s).toVar();
    const tangent = at(s.add(step)).sub(at(s.sub(step)));

    // Thin, tapering to nothing at both ends; fading in and out over its life, and near the eye.
    const distance = eye.sub(here).length();
    const taper = sin(u.mul(Math.PI)).max(0).pow(0.7);
    const thick = max(float(RIBBONS.thick), distance.mul(RIBBONS.least)).mul(taper);
    const fade = smoothstep(0, FADE.in, f)
        .mul(smoothstep(1, 1 - FADE.out, f))
        .mul(smoothstep(FADE.near[0], FADE.near[1], distance));
    return GpuSplats.Splat(
        here,
        vec3(step.mul(0.75).max(thick), thick, thick),
        xTo(tangent.add(vec3(1e-5, 0, 0))),
        vec3(RIBBONS.white[0], RIBBONS.white[1], RIBBONS.white[2]),
        taper.mul(fade).mul(RIBBONS.solid),
        uint(index),
    );
}

export type Wind = {
    object: SplatObject;
    count: number;
    update: (elapsed: number, camera: THREE.Vector3) => void;
};

export function initWind(): Wind {
    const count = RIBBONS.count * RIBBONS.splats;
    return {
        object: SplatCollection.object({ count, generator: { generateSplat } }),
        count,
        update(elapsed, camera) {
            time.value = elapsed;
            eye.value.copy(camera);
        },
    };
}
