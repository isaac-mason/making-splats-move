import * as THREE from 'three';

// The fire: how hot it's burning right now, and its own life. Every visual
// system reads this one signal, so the flame, smoke, embers, lighting and heat
// shimmer all swell together when it's stoked. Two channels:
//
//   intensity — sustained 0..1 level (the "slider"). Rises when stoked, decays
//               slowly back to a resting burn. Drives baseline brightness /
//               shimmer / flame size.
//   pulse     — 0..1 transient that ramps up on a stoke and eases back down.
//               Lets systems react to the *blast* itself, on top of the sustained level.
//
// Nobody tends it, so it looks after itself: it holds that resting burn and
// crackles on its own every few seconds. Clicking the scene (interaction.ts)
// stokes it by hand.

const RESTING_BURN = 0.45; // sustained level the untended fire settles at (0 = out, 1 = roaring)

const FUEL_MAX = 2.5; // ceiling on stored fuel (sustained level can't run away)
const FUEL_RELEASE = 0.985; // per-60fps-frame fuel decay — slow, so the swell sustains
const INTENSITY_SMOOTH = 0.12; // per-60fps-frame attack toward fuel (quick swell, eased)
const PULSE_GAIN = 1.3; // pulse fuel injected per unit stoke (so a bigger stoke flares bigger)
const PULSE_ATTACK = 0.13; // per-60fps-frame ramp of pulse toward its fuel (~180ms swell-in)
const PULSE_DECAY = 0.95; // per-60fps-frame pulse-fuel decay (the flare lasts ~1s)

// Self-crackles: small, irregular flare-ups so the fire is never static.
const CRACKLE_GAP_MIN = 1.6; // seconds between crackles, lower bound …
const CRACKLE_GAP_MAX = 5.0; // … and upper bound (picked uniformly in between)
const CRACKLE_MIN = 0.12; // stoke amount of the smallest crackle …
const CRACKLE_MAX = 0.4; // … and the largest

// A hand stoke — a whole log on the fire. Much bigger than any self-crackle.
const STOKE_AMOUNT = 1;

export type Fire = {
    /** Raw accumulated stoke energy; decays slowly toward the resting burn. Feeds `intensity`. */
    fuel: number;
    /** Smoothed sustained activity: 0 = resting … 1 = roaring. The shared slider. */
    intensity: number;
    /** Blast transient, 0..1 — ramps up on stoke, then eases back down. */
    pulse: number;
    /** Drives `pulse`: set on stoke, decays; `pulse` ramps toward it then follows it down. */
    pulseFuel: number;
    /** Debug override: when set, forces `intensity` to this value (ignores fuel). */
    override: number | null;
    /** Seconds until the next self-crackle. */
    nextCrackle: number;
};

export function initFire(): Fire {
    // Start already lit rather than fading up from cold on the first frames.
    return {
        fuel: RESTING_BURN,
        intensity: RESTING_BURN,
        pulse: 0,
        pulseFuel: 0,
        override: null,
        nextCrackle: crackleGap(),
    };
}

function crackleGap(): number {
    return CRACKLE_GAP_MIN + Math.random() * (CRACKLE_GAP_MAX - CRACKLE_GAP_MIN);
}

// `amount` scales the flare, so a small self-crackle and a whole log thrown on read
// differently. Adds sustained fuel and injects pulse fuel that `pulse` ramps up
// toward (a swell-in, not an instant flash).
function addFuel(fire: Fire, amount: number): void {
    fire.fuel = Math.min(fire.fuel + amount, FUEL_MAX);
    fire.pulseFuel = Math.max(fire.pulseFuel, amount * PULSE_GAIN);
}

// Throw a log on: a big flare plus a shower of embers. `amount` scales both.
export function stokeFire(fire: Fire, amount = STOKE_AMOUNT): void {
    addFuel(fire, amount);
    // Hold off the next self-crackle so it doesn't step on the stoke's own swell.
    fire.nextCrackle = Math.max(fire.nextCrackle, CRACKLE_GAP_MIN);
}

// Advance the fire. The per-frame rates are dt-scaled so the feel is identical at
// any framerate (they were tuned at 60fps).
export function updateFire(fire: Fire, dt: number): void {
    fire.nextCrackle -= dt;
    if (fire.nextCrackle <= 0) {
        addFuel(fire, CRACKLE_MIN + Math.random() * (CRACKLE_MAX - CRACKLE_MIN));
        fire.nextCrackle = crackleGap();
    }

    const frames = dt * 60;

    // Decay toward the resting burn rather than toward zero: whatever burnt off this
    // frame is replaced in proportion to it, so an untended fire settles at that
    // level and a stoke still decays back down to it.
    const release = FUEL_RELEASE ** frames;
    fire.fuel = fire.fuel * release + RESTING_BURN * (1 - release);
    const attack = 1 - (1 - INTENSITY_SMOOTH) ** frames;
    fire.intensity += (fire.fuel - fire.intensity) * attack;

    // Pulse fuel decays fast; the visible pulse attacks toward it (ramp-up) then
    // follows it back down — a brief swell instead of an instant flash.
    fire.pulseFuel *= PULSE_DECAY ** frames;
    const pulseAttack = 1 - (1 - PULSE_ATTACK) ** frames;
    fire.pulse += (fire.pulseFuel - fire.pulse) * pulseAttack;

    if (fire.override !== null) fire.intensity = fire.override;
}

// The combined "felt heat" (0..1) for systems that want one number: sustained
// intensity plus a dab of the stoke pulse.
export function fireHeat(fire: Fire, pulseKick = 0.6): number {
    return THREE.MathUtils.clamp(fire.intensity + fire.pulse * pulseKick, 0, 1);
}
