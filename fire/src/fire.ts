import { type Furnace, stokeFurnace } from './furnace';

// The fire's own life. In the original boiler room a crowd of creatures fed the
// furnace; here nobody tends it, so the fire looks after itself: it holds a resting
// burn and crackles on its own every few seconds. Clicking the scene
// (interaction.ts) stokes it by hand.
//
// This file only *drives* the shared furnace signal — every visual (lighting, heat
// shimmer, dust, embers) reads that signal, not this.

const RESTING_BURN = 0.45; // sustained level the untended fire settles at (0 = out, 1 = roaring)

// Self-crackles: small, irregular flare-ups so the fire is never static.
const CRACKLE_GAP_MIN = 1.6; // seconds between crackles, lower bound …
const CRACKLE_GAP_MAX = 5.0; // … and upper bound (picked uniformly in between)
const CRACKLE_MIN = 0.12; // stoke amount of the smallest crackle …
const CRACKLE_MAX = 0.4; // … and the largest

// A hand stoke — a whole log on the fire. Much bigger than any self-crackle.
const STOKE_AMOUNT = 1;

export type Fire = {
    /** Seconds until the next self-crackle. */
    nextCrackle: number;
};

export function initFire(furnace: Furnace): Fire {
    furnace.resting = RESTING_BURN;
    // Start already lit rather than fading up from cold on the first frames.
    furnace.fuel = RESTING_BURN;
    furnace.intensity = RESTING_BURN;
    return { nextCrackle: crackleGap() };
}

function crackleGap(): number {
    return CRACKLE_GAP_MIN + Math.random() * (CRACKLE_GAP_MAX - CRACKLE_GAP_MIN);
}

// Throw a log on: a big flare plus a shower of embers. `amount` scales both.
export function stokeFire(fire: Fire, furnace: Furnace, amount = STOKE_AMOUNT): void {
    stokeFurnace(furnace, amount);
    // Hold off the next self-crackle so it doesn't step on the stoke's own swell.
    fire.nextCrackle = Math.max(fire.nextCrackle, CRACKLE_GAP_MIN);
}

export function updateFire(fire: Fire, furnace: Furnace, dt: number): void {
    fire.nextCrackle -= dt;
    if (fire.nextCrackle <= 0) {
        const amount = CRACKLE_MIN + Math.random() * (CRACKLE_MAX - CRACKLE_MIN);
        stokeFurnace(furnace, amount);
        fire.nextCrackle = crackleGap();
    }
}
