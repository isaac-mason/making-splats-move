import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';

const {
    cos,
    cross,
    exp,
    float,
    floor,
    fract,
    hash,
    length,
    max,
    min,
    mix,
    normalize,
    pow,
    sign,
    sin,
    smoothstep,
    sqrt,
    step,
    uint,
    uniform,
    vec3,
    vec4,
} = TSL;

/* settings */

export const SCHEDULE = { slots: 9, period: [6, 11], skip: 0.25 };

const FIELD = { distance: [125, 175], width: 120, burst: [70, 115], climb: [1.7, 2.5], size: [0.8, 1.2], wind: [2.2, 0, 0.4] };

const GRAVITY = 9.8;

const SPLATS = { rocket: 40, stars: 560, trail: 4, smoke: 320 };
const PER_SHELL = SPLATS.rocket + 1 + SPLATS.stars * SPLATS.trail + SPLATS.smoke;

const STAR = { bright: 1.6, size: 0.09, crisp: 2 };

const ROCKET = {
    bright: 1.8,
    size: 0.1,
    streak: 0.012,
    tail: 24,
    tailEvery: 0.025,
    tailDim: 7,
    glitterLife: 0.55,
    head: [1, 0.85, 0.6],
    hot: [1, 0.55, 0.18],
    cool: [0.7, 0.16, 0.05],
};

/** The flash where a shell bursts: how long, how big (metres, for a shell of size 1) and how bright. */
const FLASH = { time: 0.2, size: 2.5, bright: 1.2 };

const SMOKE = { life: 7, spread: 0.3, rise: 0.4, size: [0.4, 0.6], opacity: 0.1, colour: [0.045, 0.048, 0.06], lit: 0.6 };

const COLOURS = [
    [1, 0.1, 0.06],
    [1, 0.36, 0.06],
    [0.42, 1, 0.22],
    [0.08, 0.2, 0.7],
    [0.44, 0.16, 0.8],
    [1, 0.95, 0.88],
];
const GOLD = [1, 0.55, 0.16];
const SILVER = [0.92, 0.93, 1];
const EMBER = [0.9, 0.22, 0.04];

const BURN = { flash: 0.15, cool: [0.55, 1], cooled: [1, 0.5, 0.35], cooling: 0.6, sputter: [0.82, 0.92], vary: 0.5, trail: 0.5 };

/* the kinds */

type Kind = {
    share: number;
    speed: number;
    drag: number;
    life: number;
    trail: number;
    streak: number;
    stars: number;
    colours: number;
    core?: number;
    change?: number;
    embers?: number;
    crackle?: number;
    strobe?: number;
    ring?: number;
    up?: number;
    fat?: number;
    split?: number;
};

const KINDS: Record<string, Kind> = {
    peony: { share: 0.18, speed: 30, drag: 1.25, life: 2.4, trail: 0.05, streak: 0.016, stars: 560, colours: 0, core: 0.25 },
    colourChange: { share: 0.1, speed: 29, drag: 1.25, life: 2.8, trail: 0.05, streak: 0.016, stars: 560, colours: 0, change: 1 },
    chrysanthemum: {
        share: 0.14,
        speed: 33,
        drag: 1.05,
        life: 3.1,
        trail: 0.12,
        streak: 0.02,
        stars: 560,
        colours: 2,
        crackle: 1,
    },
    willow: { share: 0.12, speed: 22, drag: 0.85, life: 5.5, trail: 0.2, streak: 0.025, stars: 560, colours: 1, embers: 1 },
    ring: { share: 0.1, speed: 30, drag: 1.25, life: 2.3, trail: 0.05, streak: 0.016, stars: 560, colours: 0, ring: 1 },
    palm: { share: 0.12, speed: 27, drag: 0.9, life: 3.2, trail: 0.16, streak: 0.03, stars: 36, colours: 1, up: 0.7, fat: 2 },
    crossette: { share: 0.14, speed: 26, drag: 1.1, life: 2.8, trail: 0.06, streak: 0.018, stars: 96, colours: 0, split: 0.8 },
    strobe: { share: 0.1, speed: 24, drag: 1.15, life: 3.6, trail: 0, streak: 0, stars: 420, colours: 3, strobe: 1 },
};
const KIND_LIST = Object.values(KINDS);

/* splats */

const time = uniform(0);
const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);
const wind = v3(FIELD.wind);

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

function along(dir: TslNode): TslNode {
    const x = normalize(dir.add(vec3(0, 1e-5, 0))).toVar();
    const y = normalize(
        cross(
            x,
            x.y
                .abs()
                .lessThan(0.95)
                .select(vec3(0, 1, 0), vec3(1, 0, 0)),
        ),
    ).toVar();
    return quatFromBasis(x, y, cross(x, y));
}

const sphereDir = (u: TslNode, v: TslNode): TslNode => {
    const z = u.mul(2).sub(1);
    const ring = sqrt(max(z.mul(z).oneMinus(), 0));
    const a = v.mul(Math.PI * 2);
    return vec3(cos(a).mul(ring), z, sin(a).mul(ring));
};

const pickColour = (list: readonly (readonly number[])[], at: TslNode): TslNode => {
    const i = min(floor(at.mul(list.length)), list.length - 1);
    return list.reduce<TslNode>((picked, c, k) => (k === 0 ? v3(c) : i.equal(float(k)).select(v3(c), picked)), v3(list[0]));
};

export function shellOf(slot: TslNode, clock: TslNode) {
    const sh = (n: number) => hash(slot.mul(uint(31)).add(uint(n)));
    const period = mix(SCHEDULE.period[0], SCHEDULE.period[1], sh(1)).toVar();
    const shifted = clock.add(sh(2).mul(period));
    const turn = floor(shifted.div(period));
    const since = shifted.sub(turn.mul(period)).toVar();
    const shell = slot.mul(uint(7919)).add(uint(turn));
    const r = (n: number) => hash(shell.mul(uint(97)).add(uint(n)));
    const fired = r(0).greaterThanEqual(SCHEDULE.skip);

    // What kind: its every number picked from the table.
    let threshold = 0;
    const which = KIND_LIST.reduce<TslNode>((picked, kind, i) => {
        threshold += kind.share;
        return i === 0
            ? float(0)
            : r(1)
                  .greaterThanEqual(threshold - kind.share)
                  .select(float(i), picked);
    }, float(0)).toVar();
    const of = (value: (kind: Kind) => number): TslNode =>
        KIND_LIST.reduce<TslNode>(
            (picked, kind, i) => (i === 0 ? float(value(kind)) : which.equal(float(i)).select(float(value(kind)), picked)),
            float(0),
        );

    const size = mix(FIELD.size[0], FIELD.size[1], r(9)).toVar();
    const launch = vec3(r(5).sub(0.5).mul(FIELD.width), 0, mix(FIELD.distance[0], FIELD.distance[1], r(6)).negate()).toVar();
    const height = mix(FIELD.burst[0], FIELD.burst[1], r(7)).mul(size.mul(0.3).add(0.7));
    const climb = mix(FIELD.climb[0], FIELD.climb[1], r(8)).toVar();
    const burst = launch
        .add(vec3(0, height, 0))
        .add(wind.mul(climb.mul(0.3)))
        .toVar();
    const after = since.sub(climb).toVar();

    const colours = of((kind) => kind.colours);
    const main = colours
        .equal(1)
        .select(
            v3(GOLD),
            colours
                .equal(2)
                .select(
                    r(4).lessThan(0.5).select(v3(GOLD), v3(SILVER)),
                    colours.equal(3).select(v3(SILVER), pickColour(COLOURS, r(2))),
                ),
        )
        .toVar();
    const second = pickColour(COLOURS, r(3));
    return { period, since, shell, r, fired, which, of, size, launch, height, climb, burst, after, main, second };
}

function generateSplat(index: TslNode) {
    const slot = index.div(uint(PER_SHELL));
    const k = index.mod(uint(PER_SHELL));
    const { period, since, shell, r, fired, of, size, launch, height, climb, burst, after, main, second } = shellOf(slot, time);

    const climbAt = (t: TslNode) => {
        const u = t.div(climb).clamp(0, 1);
        return launch.add(vec3(0, height.mul(u.mul(u.oneMinus().add(1))), 0)).add(wind.mul(t.mul(0.3)));
    };
    const climbing = (t: TslNode) => {
        const u = t.div(climb).clamp(0, 1);
        return vec3(0, height.mul(u.oneMinus().mul(2)).div(climb), 0).add(wind.mul(0.3));
    };
    const j = float(k);
    const isGlitter = j.greaterThan(ROCKET.tail);
    const tailBack = j.mul(ROCKET.tailEvery);
    const sampled = since.sub(tailBack);
    const tailGlow = exp(j.div(-ROCKET.tailDim));
    const tailHue = mix(
        mix(v3(ROCKET.head), v3(ROCKET.hot), smoothstep(0, 3, j)),
        v3(ROCKET.cool),
        smoothstep(3, ROCKET.tail, j),
    );
    const pace = climbing(sampled).toVar();
    // Glitter: shed from the tail every so often, drifting off and down, flickering out.
    const g = j.sub(ROCKET.tail);
    const phase = fract(sin(g.mul(12.9).add(r(13).mul(40))).mul(43758.5));
    const glitterAge = fract(since.div(ROCKET.glitterLife).add(phase)).mul(ROCKET.glitterLife).toVar();
    const shed = since.sub(glitterAge);
    const drift = vec3(sin(g.mul(7.1)), -1, cos(g.mul(3.7))).mul(glitterAge.mul(1.2));
    const glitterAt = climbAt(shed).add(drift);
    const glitterGlow = smoothstep(ROCKET.glitterLife, 0, glitterAge).mul(step(0.4, fract(time.mul(17).add(g.mul(0.37)))));
    const rocketAt = isGlitter.select(glitterAt, climbAt(sampled));
    const sinceLit = isGlitter.select(shed, sampled);
    const rocketSeen = sinceLit
        .greaterThan(0)
        .and(sinceLit.lessThan(climb))
        .select(smoothstep(4, 12, rocketAt.y), float(0));
    const rocketThick = float(ROCKET.size).mul(isGlitter.select(float(0.5), tailGlow.mul(0.6).add(0.4)));
    const rocket = {
        center: rocketAt,
        scales: vec3(max(rocketThick, isGlitter.select(float(0), length(pace).mul(ROCKET.streak))), rocketThick, rocketThick),
        quaternion: along(pace),
        rgb: isGlitter.select(v3(ROCKET.hot).mul(glitterGlow), tailHue.mul(tailGlow)).mul(ROCKET.bright),
        opacity: rocketSeen
            .mul(isGlitter.select(glitterGlow, tailGlow))
            .mul(STAR.crisp - 1)
            .add(rocketSeen),
    };

    /* the flash */
    const flashLeft = float(1).sub(after.div(FLASH.time)).clamp(0, 1);
    const flash = {
        center: burst,
        scales: vec3(FLASH.size).mul(size),
        quaternion: vec4(0, 0, 0, 1),
        rgb: mix(main, vec3(1), 0.5).mul(flashLeft.mul(flashLeft).mul(FLASH.bright)),
        opacity: after.greaterThan(0).select(flashLeft.mul(0.35), float(0)),
    };

    /* the stars */
    const s = float(k.sub(uint(SPLATS.rocket + 1)));
    const star = floor(s.div(SPLATS.trail));
    const back = s.sub(star.mul(SPLATS.trail));
    const count = of((kind) => kind.stars);
    const splitAt = of((kind) => kind.split ?? 0).toVar();
    const splits = splitAt.greaterThan(0);
    const parents = splits.select(count.div(4), count).toVar();
    const parent = splits.select(star.mod(parents), star).toVar();
    const child = splits.select(floor(star.div(parents)), float(0)).toVar();
    const starPath = (who: TslNode) => {
        const hs = (n: number) =>
            hash(
                shell
                    .mul(uint(4099))
                    .add(uint(floor(who)))
                    .mul(uint(7))
                    .add(uint(n)),
            );
        const z = who.add(0.5).div(parents).mul(2).sub(1);
        const spiral = sqrt(max(z.mul(z).oneMinus(), 0));
        const turnBy = who.mul(2.399963).add(r(10).mul(Math.PI * 2));
        const outward = vec3(cos(turnBy).mul(spiral), z, sin(turnBy).mul(spiral));
        const ringNormal = normalize(vec3(r(11).sub(0.5), r(12).sub(0.5).mul(1.2), 1));
        const ringSide = normalize(cross(ringNormal, vec3(0, 1, 0)));
        const ringUp = cross(ringSide, ringNormal);
        const ringAngle = who.div(parents).mul(Math.PI * 2);
        const ring = ringSide.mul(cos(ringAngle)).add(ringUp.mul(sin(ringAngle)));
        const flung = vec3(
            0,
            of((kind) => kind.up ?? 0),
            0,
        );
        const dir = of((kind) => kind.ring ?? 0)
            .greaterThan(0.5)
            .select(ring, normalize(outward.add(sphereDir(hs(0), hs(1)).mul(0.08)).add(flung)));
        const isCore = hs(2).lessThan(of((kind) => kind.core ?? 0));
        const speed = of((kind) => kind.speed)
            .mul(size)
            .mul(hs(3).mul(0.12).add(0.92))
            .mul(isCore.select(float(0.45), float(1)));
        const life = of((kind) => kind.life).mul(hs(4).mul(0.4).add(0.8));
        return { dir, speed, life, isCore, hs };
    };
    const { dir, speed, life, isCore, hs } = starPath(parent);
    const drag = of((kind) => kind.drag);

    const t = after.sub(back.mul(of((kind) => kind.trail))).toVar();
    const terminal = wind.add(vec3(0, -GRAVITY, 0).div(drag));
    const fly = (from: TslNode, v0: TslNode, dt: TslNode) => {
        const eased = exp(drag.negate().mul(max(dt, 0)));
        return {
            at: from.add(terminal.mul(max(dt, 0))).add(v0.sub(terminal).mul(eased.oneMinus().div(drag))),
            velocity: terminal.add(v0.sub(terminal).mul(eased)),
        };
    };
    const first = fly(burst, dir.mul(speed), splits.select(min(t, splitAt), t));
    const split = splits.and(t.greaterThan(splitAt));
    const kickSide = normalize(cross(first.velocity, vec3(0, 0, 1)).add(vec3(0, 1e-4, 0)));
    const kickUp = normalize(cross(first.velocity, kickSide));
    const kickAngle = child.mul(Math.PI / 2).add(hs(6).mul(Math.PI));
    const kick = kickSide
        .mul(cos(kickAngle))
        .add(kickUp.mul(sin(kickAngle)))
        .mul(speed.mul(0.4));
    const afterSplit = fly(first.at, first.velocity.add(kick), t.sub(splitAt));
    const starAt = split.select(afterSplit.at, first.at);
    const velocity = split.select(afterSplit.velocity, first.velocity);

    const hot = max(smoothstep(BURN.flash, 0, t), split.select(smoothstep(BURN.flash, 0, t.sub(splitAt)), float(0)));
    const burning = t.div(life).clamp(0, 1);
    const changed = of((kind) => kind.change ?? 0).mul(step(0.5, burning));
    const cooled = mix(vec3(1), v3(BURN.cooled), smoothstep(BURN.cool[0], BURN.cool[1], burning).mul(BURN.cooling));
    const hue = of((kind) => kind.embers ?? 0)
        .greaterThan(0.5)
        .select(mix(v3(GOLD), v3(EMBER), burning), mix(isCore.select(second, main), second, changed).mul(cooled));
    const fade = smoothstep(1, 0.55, burning);
    const flicker = step(
        0.5,
        hash(
            uint(star)
                .add(uint(floor(time.mul(22)).mul(131)))
                .add(shell),
        ),
    );
    const crackle = of((kind) => kind.crackle ?? 0).mul(smoothstep(0.6, 0.75, burning));
    const blink = step(0.45, fract(time.mul(9).add(hs(5).mul(10))));
    const strobe = of((kind) => kind.strobe ?? 0);
    const trailFade = pow(BURN.trail, back);
    const sputter = smoothstep(BURN.sputter[0], BURN.sputter[1], burning).mul(flicker.mul(0.8).sub(0.4)).add(1);
    const glow = fade
        .mul(trailFade)
        .mul(sputter)
        .mul(hs(7).sub(0.5).mul(BURN.vary).add(1))
        .mul(crackle.mul(flicker.mul(2.2).sub(1)).add(1))
        .mul(strobe.mul(blink.mul(1.6).sub(1)).add(1))
        .mul(hot.mul(0.6).add(1));
    const seen = t
        .greaterThan(0)
        .and(t.lessThan(life))
        .and(star.lessThan(count))
        .and(split.or(child.equal(0)))
        .and(back.equal(0).or(of((kind) => kind.trail).greaterThan(0)));
    const thick = of((kind) => kind.fat ?? 1).mul(STAR.size);
    const stars = {
        center: starAt,
        scales: vec3(max(length(velocity).mul(of((kind) => kind.streak)), thick), thick, thick)
            .mul(back.mul(-0.15).add(1))
            .mul(fade.mul(0.4).add(0.6)),
        quaternion: along(velocity),
        rgb: mix(hue, vec3(1, 0.95, 0.85), hot.mul(0.7)).mul(glow.mul(STAR.bright)),
        opacity: seen.select(
            fade
                .mul(trailFade)
                .mul(STAR.crisp - 1)
                .add(1),
            float(0),
        ),
    };

    const m = float(k.sub(uint(SPLATS.rocket + 1 + SPLATS.stars * SPLATS.trail)));
    const hm = (n: number) => hash(shell.mul(uint(613)).add(uint(m)).mul(uint(5)).add(uint(n)));
    const age = max(after, 0);
    const trailed = starPath(floor(hm(0).mul(parents)));
    const leftAt = hm(1).mul(min(age, trailed.life.mul(0.85)));
    const drifted = age.sub(leftAt);
    const smokeAt = fly(burst, trailed.dir.mul(trailed.speed), leftAt)
        .at.add(wind.mul(drifted))
        .add(vec3(0, drifted.mul(SMOKE.rise), 0))
        .add(sphereDir(hm(2), hm(3)).mul(drifted.mul(SMOKE.spread)));
    const lit = exp(age.mul(-1.2)).mul(SMOKE.lit);
    const allowed = min(period.sub(climb), SMOKE.life);
    const smokeLeft = smoothstep(allowed, allowed.mul(0.4), age).mul(smoothstep(0, 0.3, drifted));
    const smoke = {
        center: smokeAt,
        scales: vec3(drifted.mul(SMOKE.size[1]).add(SMOKE.size[0])).mul(size),
        quaternion: vec4(0, 0, 0, 1),
        rgb: v3(SMOKE.colour).add(main.mul(lit)),
        opacity: after.greaterThan(0).select(smokeLeft.mul(SMOKE.opacity), float(0)),
    };

    const isRocket = k.lessThan(uint(SPLATS.rocket));
    const isFlash = k.equal(uint(SPLATS.rocket));
    const isSmoke = k.greaterThanEqual(uint(SPLATS.rocket + 1 + SPLATS.stars * SPLATS.trail));
    const part = (key: 'center' | 'scales' | 'quaternion' | 'rgb' | 'opacity') =>
        isRocket.select(rocket[key], isFlash.select(flash[key], isSmoke.select(smoke[key], stars[key])));
    const opacity = fired.select(part('opacity'), float(0));
    return GpuSplats.Splat(part('center'), part('scales'), part('quaternion'), part('rgb'), opacity, uint(index));
}

export type Show = {
    object: SplatObject;
    centre: THREE.Vector3;
    update: (elapsed: number) => void;
};

export function initShow(): Show {
    const object = SplatCollection.object({
        count: SCHEDULE.slots * PER_SHELL,
        generator: { generateSplat },
        params: { lodInflate: false },
    });
    const middle = (FIELD.burst[0] + FIELD.burst[1]) / 2;
    return {
        object,
        centre: new THREE.Vector3(0, middle * 0.8, -(FIELD.distance[0] + FIELD.distance[1]) / 2),
        update(elapsed) {
            time.value = elapsed;
        },
    };
}
