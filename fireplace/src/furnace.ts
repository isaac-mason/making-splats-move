import * as THREE from 'three';

// Single source of truth for "how active is the fire right now" — the shared
// signal every visual system reads, so lighting, heat shimmer, dust and embers
// all swell together when the fire is stoked. Two channels:
//
//   intensity — sustained 0..1 level (the "slider"). Rises when stoked, decays
//               slowly. Drives baseline brightness / shimmer / dust glow.
//   pulse     — 0..1 transient that ramps up on a stoke and eases back down.
//               Lets systems react to the *blast* itself, on top of the sustained level.

export type Furnace = {
    /** Raw accumulated stoke energy; decays slowly. Feeds `intensity`. */
    fuel: number;
    /** Smoothed sustained activity: 0 = resting … 1 = roaring. The shared slider. */
    intensity: number;
    /** Blast transient, 0..1 — ramps up on stoke, then eases back down. */
    pulse: number;
    /** Drives `pulse`: set on stoke, decays; `pulse` ramps toward it then follows it down. */
    pulseFuel: number;
    /** Debug override: when set, forces `intensity` to this value (ignores fuel). */
    override: number | null;
    /** Baseline fuel the fire settles back to, so it keeps burning untended (0 = gutters out). */
    resting: number;
};

const FUEL_MAX = 2.5; // ceiling on stored fuel (sustained level can't run away)
const FUEL_RELEASE = 0.985; // per-60fps-frame fuel decay — slow, so the swell sustains
const INTENSITY_SMOOTH = 0.12; // per-60fps-frame attack toward fuel (quick swell, eased)
const PULSE_GAIN = 1.3; // pulse fuel injected per unit stoke (so a bigger stoke flares bigger)
const PULSE_ATTACK = 0.13; // per-60fps-frame ramp of pulse toward its fuel (~180ms swell-in)
const PULSE_DECAY = 0.95; // per-60fps-frame pulse-fuel decay (the flare lasts ~1s)

export function initFurnace(): Furnace {
    return { fuel: 0, intensity: 0, pulse: 0, pulseFuel: 0, override: null, resting: 0 };
}

// Stoke the fire — `amount` scales the flare, so a small self-crackle and a whole log
// thrown on read differently. Adds sustained fuel and injects pulse fuel that `pulse`
// ramps up toward (a swell-in, not an instant flash).
export function stokeFurnace(furnace: Furnace, amount = 1): void {
    furnace.fuel = Math.min(furnace.fuel + amount, FUEL_MAX);
    furnace.pulseFuel = Math.max(furnace.pulseFuel, amount * PULSE_GAIN);
}

// Advance the signal. The per-frame rates are dt-scaled so the feel is identical
// at any framerate (they were tuned at 60fps).
export function updateFurnace(furnace: Furnace, dt: number): void {
    const frames = dt * 60;

    // Decay toward the resting baseline rather than toward zero: whatever burnt off
    // this frame is replaced in proportion to `resting`, so an untended fire settles
    // at that level and a stoke still decays back down to it.
    const release = FUEL_RELEASE ** frames;
    furnace.fuel = furnace.fuel * release + furnace.resting * (1 - release);
    const attack = 1 - (1 - INTENSITY_SMOOTH) ** frames;
    furnace.intensity += (furnace.fuel - furnace.intensity) * attack;

    // Pulse fuel decays fast; the visible pulse attacks toward it (ramp-up) then
    // follows it back down — a brief swell instead of an instant flash.
    furnace.pulseFuel *= PULSE_DECAY ** frames;
    const pulseAttack = 1 - (1 - PULSE_ATTACK) ** frames;
    furnace.pulse += (furnace.pulseFuel - furnace.pulse) * pulseAttack;

    if (furnace.override !== null) furnace.intensity = furnace.override;
}

// The combined "felt heat" (0..1) for systems that want one number: sustained
// intensity plus a dab of the stoke pulse.
export function furnaceHeat(furnace: Furnace, pulseKick = 0.6): number {
    return THREE.MathUtils.clamp(furnace.intensity + furnace.pulse * pulseKick, 0, 1);
}
