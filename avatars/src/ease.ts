/** Ease in and out of a 0..1 blend, so it settles instead of stopping dead. */
export function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}
