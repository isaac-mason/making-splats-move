import { type SplatModifier, TSL, type TslNode } from '@sparkjsdev/radix';
import type * as THREE from 'three';

const { If, abs, exp, hash, length, max, pow, select, sin, smoothstep, uniform, vec3 } = TSL;

/** The ripple takes 2 seconds to travel 110 metres, the far edge of the scene. */
const DURATION = 2;
const REACH = 110;
const EASE = 2.2;
const SEED = 2.5;
/** The ripple never moves slower than this, in metres per second. */
const MIN_SPEED = 6;

const BAND_TIME = 0.1;
const WAVE_TIME = 0.26;
const CREST_TIME = 0.38;

const AMPLITUDE = 0.55; // how far a splat bobs outward, in metres
const SWELL = 0.8;
const WOBBLE = 2.0; // how lumpy the ripple's shape is, in metres
const RAGGED = 1.2; // how rough its edge is, in metres

const GLOW = [1.0, 0.72, 0.3] as const;
const GLOW_FOCUS = 4.0;
const GLOW_GAIN = 3.0;

function rippleAt(time: number): { radius: number; speed: number } {
    const t = Math.max(time, 0) / DURATION;
    return {
        radius: REACH * t ** EASE,
        speed: Math.max(MIN_SPEED, (REACH * EASE * t ** (EASE - 1)) / DURATION),
    };
}

function timeAt(radius: number): number {
    return DURATION * (radius / REACH) ** (1 / EASE);
}

export type Reveal = {
    time: number;
    armed: boolean;
    running: boolean;
    /** How far the ripple has spread, in metres. */
    radius: number;
    modifier: SplatModifier;
    uRadius: TslNode;
    uSpeed: TslNode;
};

export function initReveal(origin: THREE.Vector3): Reveal {
    const uRadius = uniform(SEED);
    const uSpeed = uniform(MIN_SPEED);
    const uOrigin = uniform(origin.clone());

    const modifier: SplatModifier = (splat) => {
        const out = splat.toVar();

        const grain = hash(splat.get('index')).toVar();

        const offset = splat.get('center').sub(uOrigin).toVar();
        const dist = length(offset).toVar();
        const dir = select(dist.greaterThan(1e-4), offset.div(max(dist, 1e-4)), vec3(0, 1, 0)).toVar();

        const phase = uRadius.mul(0.35).toVar();
        const wobble = sin(dir.x.mul(1.7).add(dir.y.mul(2.3)).add(phase)).add(
            sin(dir.z.mul(2.1).sub(dir.y.mul(1.1)).sub(phase.mul(0.7))),
        );
        const arrival = dist.add(wobble.mul(WOBBLE)).add(grain.sub(0.5).mul(RAGGED));

        // How far the ripple has gone past this splat, in metres.
        const w = uRadius.sub(arrival).toVar();
        If(w.lessThanEqual(0), () => {
            out.get('opacity').assign(0);
        }).Else(() => {
            const appear = smoothstep(0, uSpeed.mul(BAND_TIME), w).toVar();
            const ripple = sin(w.mul(Math.PI * 2).div(uSpeed.mul(CREST_TIME)))
                .mul(exp(w.negate().div(uSpeed.mul(WAVE_TIME))))
                .toVar();
            const flare = pow(abs(ripple), GLOW_FOCUS).mul(GLOW_GAIN);

            out.get('center').addAssign(dir.mul(ripple.mul(AMPLITUDE)));
            out.get('scales').mulAssign(appear.mul(ripple.mul(SWELL).add(1)));
            out.get('rgb').addAssign(vec3(...GLOW).mul(flare));
            out.get('opacity').mulAssign(appear);
        });

        return out;
    };

    return { time: timeAt(SEED), armed: false, running: false, radius: SEED, modifier, uRadius, uSpeed };
}

export function armReveal(reveal: Reveal): void {
    reveal.armed = true;
}

/** Play the ripple again from the start. */
export function replayReveal(reveal: Reveal): void {
    reveal.time = timeAt(SEED);
}

export function updateReveal(reveal: Reveal, dt: number, drawing: boolean, frozenTime: number | null = null): boolean {
    if (!reveal.running) {
        if (!reveal.armed || !drawing) return false;
        reveal.running = true;
    }
    if (frozenTime === null && reveal.time >= DURATION) return false;
    reveal.time = frozenTime ?? Math.min(DURATION, reveal.time + dt);
    const ripple = rippleAt(reveal.time);
    if (ripple.radius === reveal.radius) return false;
    reveal.radius = ripple.radius;
    reveal.uRadius.value = ripple.radius;
    reveal.uSpeed.value = ripple.speed;
    return true;
}
