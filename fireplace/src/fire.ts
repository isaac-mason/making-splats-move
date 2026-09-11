import { type Furnace, furnaceHeat, stokeFurnace } from './furnace';
import { SPARK_ORIGIN } from './scene';
import { type Sparks, sparksBurst } from './sparks';

// The fire's own life. In the original boiler room a crowd of creatures fed the
// furnace; here nobody tends it, so the fire looks after itself: it holds a resting
// burn, crackles on its own every few seconds, and sheds a steady trickle of embers
// that thickens as it flares. Clicking the scene (interaction.ts) stokes it by hand.
//
// This file only *drives* the shared furnace signal — every visual (lighting, heat
// shimmer, dust, embers) reads that signal, not this.

const RESTING_BURN = 0.45; // sustained level the untended fire settles at (0 = out, 1 = roaring)

// Self-crackles: small, irregular flare-ups so the fire is never static.
const CRACKLE_GAP_MIN = 1.6; // seconds between crackles, lower bound …
const CRACKLE_GAP_MAX = 5.0; // … and upper bound (picked uniformly in between)
const CRACKLE_MIN = 0.12; // stoke amount of the smallest crackle …
const CRACKLE_MAX = 0.4; // … and the largest
const CRACKLE_EMBERS = 26; // embers per unit of crackle

// A hand stoke — a whole log on the fire. Much bigger than any self-crackle.
const STOKE_AMOUNT = 1;
const STOKE_EMBERS = 60; // embers per unit of stoke

// The always-on ember trickle rising off the coals.
const TRICKLE_RATE = 14; // embers/second at full heat
const TRICKLE_FLOOR = 0.25; // … scaled to this fraction of the rate when resting

export type Fire = {
    /** Seconds until the next self-crackle. */
    nextCrackle: number;
    /** Fractional embers owed by the trickle, carried between frames. */
    emberDebt: number;
};

export function initFire(furnace: Furnace): Fire {
    furnace.resting = RESTING_BURN;
    // Start already lit rather than fading up from cold on the first frames.
    furnace.fuel = RESTING_BURN;
    furnace.intensity = RESTING_BURN;
    return { nextCrackle: crackleGap(), emberDebt: 0 };
}

function crackleGap(): number {
    return CRACKLE_GAP_MIN + Math.random() * (CRACKLE_GAP_MAX - CRACKLE_GAP_MIN);
}

// Throw a log on: a big flare plus a shower of embers. `amount` scales both.
export function stokeFire(fire: Fire, furnace: Furnace, sparks: Sparks, amount = STOKE_AMOUNT): void {
    stokeFurnace(furnace, amount);
    sparksBurst(sparks, SPARK_ORIGIN, Math.round(STOKE_EMBERS * amount));
    // Hold off the next self-crackle so it doesn't step on the stoke's own swell.
    fire.nextCrackle = Math.max(fire.nextCrackle, CRACKLE_GAP_MIN);
}

export function updateFire(fire: Fire, furnace: Furnace, sparks: Sparks, dt: number): void {
    fire.nextCrackle -= dt;
    if (fire.nextCrackle <= 0) {
        const amount = CRACKLE_MIN + Math.random() * (CRACKLE_MAX - CRACKLE_MIN);
        stokeFurnace(furnace, amount);
        sparksBurst(sparks, SPARK_ORIGIN, Math.round(CRACKLE_EMBERS * amount));
        fire.nextCrackle = crackleGap();
    }

    // Trickle: accumulate a fractional ember count so low rates still emit evenly
    // instead of rounding down to nothing every frame.
    const heat = furnaceHeat(furnace);
    const rate = TRICKLE_RATE * (TRICKLE_FLOOR + (1 - TRICKLE_FLOOR) * heat);
    fire.emberDebt += rate * dt;
    const due = Math.floor(fire.emberDebt);
    if (due > 0) {
        fire.emberDebt -= due;
        sparksBurst(sparks, SPARK_ORIGIN, due);
    }
}
