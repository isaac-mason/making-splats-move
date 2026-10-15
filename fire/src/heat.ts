/**
 * Heat shimmer: wobbles the captured scene's splats in a column of hot air over the
 * fire, hardest just above the coals.
 *
 * A modifier on the scene's generator, not the renderer, so the flame's own splats
 * aren't shaken twice. The scene object sits at the origin, so its object space is
 * world space.
 */

import { type SplatModifier, TSL, type TslNode } from 'spark-radix';
import { type Fire, fireHeat } from './fire';
import { FIRE_ORIGIN } from './scene';
import { time, v3 } from './tsl';

const { Fn, If, abs, clamp, dot, exp, floor, fract, length, mix, mod, smoothstep, uniform, vec2, vec3 } = TSL;

const H = {
    baseRadius: 0.55,
    plumeHeight: 1.9,
    maxOffset: 0.009,
    rippleFrequency: 5.5,
    // Whole: the noise tiles at this period, which is what lets the scroll loop seamlessly.
    noisePeriod: 8,
    loopSeconds: 6,
};

const heatHash = Fn(([p]: TslNode[]) => {
    const q = fract(p.mul(vec2(0.3183099, 0.3678794)).add(0.1)).toVar();
    q.addAssign(dot(q, q.add(27.13)));
    return fract(q.x.mul(q.y));
}).setLayout({ name: 'heatHash', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

const heatNoise = Fn(([x]: TslNode[]) => {
    const i = floor(x).toVar();
    const f = fract(x).toVar();
    const u = f.mul(f).mul(f.mul(-2).add(3)).toVar();
    const corner = (dx: number, dy: number) => heatHash(mod(i.add(vec2(dx, dy)), H.noisePeriod));
    return mix(mix(corner(0, 0), corner(1, 0), u.x), mix(corner(0, 1), corner(1, 1), u.x), u.y);
}).setLayout({ name: 'heatNoise', type: 'float', inputs: [{ name: 'x', type: 'vec2' }] });

export type Heat = { modifier: SplatModifier; fed: TslNode };

export function initHeat(): Heat {
    const fed = uniform(0);
    const origin = v3(FIRE_ORIGIN);

    const modifier: SplatModifier = (splat) => {
        const out = splat.toVar();
        const center = splat.get('center').toVar();
        const rel = center.sub(origin).toVar();
        const up = rel.y;

        const width = clamp(up.div(H.plumeHeight), 0, 1).mul(0.6).add(0.5).mul(H.baseRadius).toVar();
        const inColumn = smoothstep(width.mul(0.35), width, length(rel.xz))
            .oneMinus()
            .mul(smoothstep(-0.32, -0.06, up))
            .mul(smoothstep(H.plumeHeight * 0.45, H.plumeHeight, up).oneMinus())
            .toVar();
        const overCoals = exp(up.mul(up).mul(-18)).mul(1.4).add(0.5);
        const mask = inColumn.mul(inColumn).mul(overCoals).toVar();

        If(mask.greaterThan(0), () => {
            const scroll = fract(time.div(H.loopSeconds)).mul(H.noisePeriod).toVar();
            const p = center.mul(H.rippleFrequency).toVar();
            const noise = vec3(
                heatNoise(p.yz.add(vec2(0, scroll.mul(-2)))),
                heatNoise(p.xz.mul(1.1).add(vec2(scroll.negate(), scroll))),
                heatNoise(p.xy.mul(1.3).add(vec2(scroll, scroll.mul(-2)))),
            )
                .mul(2)
                .sub(1)
                .toVar();
            const offset = vec3(noise.x, abs(noise.y).mul(1.5), noise.z);
            out.get('center').addAssign(offset.mul(mask.mul(fed.mul(1.5).add(1)).mul(H.maxOffset)));
        });

        return out;
    };

    return { modifier, fed };
}

export function updateHeat(heat: Heat, fire: Fire): void {
    heat.fed.value = fireHeat(fire, 0.9);
}
