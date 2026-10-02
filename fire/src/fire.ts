/**
 * How hard the fire is burning. Flame, smoke, embers, lighting and heat shimmer all
 * read this one state, so they swell together when it's stoked.
 *
 * Two channels, each a value easing toward a store of fuel:
 *
 *   intensity — the sustained level, 0 = resting … 1 = roaring. Its fuel burns back
 *               down to a resting level, never to zero, so an untended fire holds.
 *   pulse     — the flare from one stoke: swells in over ~200ms, gone in about a second.
 *
 * Left alone it crackles every few seconds; a click (interaction.ts) throws a log on.
 */

import * as THREE from 'three';

const { damp, randFloat, clamp } = THREE.MathUtils;

const RESTING_BURN = 0.45;
const FUEL_MAX = 2.5;
const FUEL_BURN = 0.9;
const INTENSITY_FOLLOW = 7.7;
const PULSE_BURN = 3.1;
const PULSE_FOLLOW = 8.4;
const PULSE_GAIN = 1.3;
const CRACKLE_GAP: [number, number] = [1.6, 5.0];
const CRACKLE_SIZE: [number, number] = [0.12, 0.4];

export type Fire = {
    fuel: number;
    intensity: number;
    pulseFuel: number;
    pulse: number;
    /** Debug: pins `intensity` to this value. */
    override: number | null;
    /** Seconds until the next self-crackle. */
    nextCrackle: number;
};

export function initFire(): Fire {
    return {
        fuel: RESTING_BURN,
        intensity: RESTING_BURN,
        pulseFuel: 0,
        pulse: 0,
        override: null,
        nextCrackle: randFloat(...CRACKLE_GAP),
    };
}

export function stokeFire(fire: Fire, amount = 1): void {
    addFuel(fire, amount);
    fire.nextCrackle = Math.max(fire.nextCrackle, CRACKLE_GAP[0]);
}

export function updateFire(fire: Fire, dt: number): void {
    fire.nextCrackle -= dt;
    if (fire.nextCrackle <= 0) {
        addFuel(fire, randFloat(...CRACKLE_SIZE));
        fire.nextCrackle = randFloat(...CRACKLE_GAP);
    }

    fire.fuel = damp(fire.fuel, RESTING_BURN, FUEL_BURN, dt);
    fire.intensity = damp(fire.intensity, fire.fuel, INTENSITY_FOLLOW, dt);
    fire.pulseFuel = damp(fire.pulseFuel, 0, PULSE_BURN, dt);
    fire.pulse = damp(fire.pulse, fire.pulseFuel, PULSE_FOLLOW, dt);

    if (fire.override !== null) fire.intensity = fire.override;
}

export function fireHeat(fire: Fire, pulseKick = 0.6): number {
    return clamp(fire.intensity + fire.pulse * pulseKick, 0, 1);
}

function addFuel(fire: Fire, amount: number): void {
    fire.fuel = Math.min(fire.fuel + amount, FUEL_MAX);
    fire.pulseFuel = Math.max(fire.pulseFuel, amount * PULSE_GAIN);
}
