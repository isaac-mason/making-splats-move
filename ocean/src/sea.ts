/**
 * The sea, all splats: a sheet of them over the water, each one moved by the
 * waves and the wake and lit as the water there would be, every frame.
 *
 * The splats are a clipmap round the camera: square rings of them, each ring
 * twice the size and twice as coarse as the one inside it, so a splat covers
 * about the same patch of the screen near and far. Each ring's grid is fixed in
 * the world (it moves only in whole steps with the camera), so the water doesn't
 * swim as you move. Each splat's a flat Gaussian lying along the surface, wide
 * and overlapping, so neighbours blend into one smooth sheet.
 *
 * What moves them is worked out off-screen, on the GPU:
 * - the waves (waves.ts): an FFT ocean, Tessendorf's, the way Sea of Thieves makes
 *   its sea. Each splat reads where its bit of water has been carried (up and
 *   down, and sideways by the chop, so crests sharpen and troughs widen), which
 *   way it faces, and how squeezed the chop has made it, which is where the
 *   whitecaps are. The finest waves a splat's too big to show are counted as
 *   roughness instead.
 * - the wake (wake.ts): simulated water round the boat, its height and slope and
 *   the foam it leaves.
 *
 * And each splat's lit as it's made, after Sea of Thieves: the sky reflected by
 * Fresnel, clouds and all; the sun's glitter, tight up close and spreading into a
 * broad path far off as the roughness grows; under that the deep blue-green of
 * the water, darker turned from the sun, and bright teal where the light comes
 * through the crests; whitecaps and the wake's foam, frothy; the boat's shadow;
 * and haze far off.
 *
 * Sections: settings · the waves · the sky · the froth · the sheet · the sea.
 */

import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';
import type { Wake } from './wake';
import { TEXELS, type Waves } from './waves';

const {
    Fn,
    If,
    abs,
    cos,
    dot,
    exp,
    float,
    mx_noise_float,
    max,
    mix,
    normalize,
    pow,
    reflect,
    sin,
    smoothstep,
    texture,
    exp2,
    round,
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

/* settings */

/**
 * The sheet: this many rings, each a square grid this many splats across, the
 * innermost spaced this far apart (metres): 8 rings of 256 reach some 700 m, where
 * the haze has it. How big a splat is for its spacing (its Gaussian's standard
 * deviation, as a share: wide, so neighbours blend smoothly into each other); how
 * solid (past 1, with lodInflate off, its middle's opaque, so there are no gaps,
 * even where the chop stretches the water, and only its rim blends); and how thin. How fine the waves drawn are, by distance: a splat that
 * far off is between 2 and 4 rings' worth of spacings across (over the grid's
 * width), so this is in the middle. Where each ring hands over to the next: from
 * this far out across it to this far (shares of its half-width).
 */
const SHEET = { rings: 8, across: 256, spacing: 0.045, wide: 0.85, solid: 1.0, thin: 0.03, footprint: 3, handover: [0.78, 0.95] };

/** The wind: which way it blows (radians round from +x towards +z), and how fast the gusts and froth drift with it (m/s). */
const WIND = { towards: -2.2, drift: 1.5 };

/**
 * Gusts: patches of rougher and calmer water drifting with the wind, the ripples
 * this much weaker to this much stronger, this big (metres).
 */
const GUSTS = { calm: 0.4, rough: 1.4, size: 45 };

/** How fine a wave tile a splat can show, as its size over the tile's texel: fully up to `full`, gone by `gone`. */
const DRAWN = { full: 0.6, gone: 2.5 };

/**
 * Whitecaps: where the chop squeezes the surface (its Jacobian, 1 untouched, 0
 * folded over) under this, thickening to full by this; how much the gusts and the
 * froth break their edges up.
 */
const CAPS = { from: 0.62, full: 0.3, broken: 0.25 };

/**
 * The sun: where it is (towards it: ahead of you as you set out, lowish, so its
 * glitter's in view), how bright its disc is and how much light its glitter has
 * in all, spread over however rough the water is; and how far below the boat's
 * middle its shadow is cast from (metres).
 */
export const SUN = { dir: new THREE.Vector3(-0.3, 0.42, -0.86).normalize(), size: 0.02, glitter: 0.7, castFrom: 0.45 };

/**
 * The water's own colours, sRGB, after Sea of Thieves: the deep blue-green that
 * comes up out of it; the bright teal of the light through the crests (from this
 * high above the mean, metres, to this), and how much more of it looking towards the sun; and
 * how much the side away from the sun darkens. How much of the sky it reflects at
 * most, and the boat's shadow.
 */
const WATER = {
    deep: '#0a3a5e',
    through: '#18a99a',
    throughFrom: [0.15, 0.9],
    throughShare: 0.7,
    towardsSun: 0.6,
    away: 0.55,
    reflects: 0.75,
    shadow: 0.55,
};

/** The wake's froth: its noise this size (metres), a finer froth through it this many times smaller, how white it is, and its colour. */
const FOAM = { size: 1.4, fine: 4.5, white: 0.9, colour: '#f2f7f8' };

/**
 * The sky, sRGB: deep blue overhead, paling to a near-white cyan at the horizon;
 * the sun's warm glow (how bright, how tight).
 */
const SKY = { zenith: '#2a7fd6', horizon: '#c6e6f7', glow: '#fff3d9', glowBright: 0.35, glowTight: 48 };

/**
 * Clouds: puffs of noise cut off crisp, low round the sky. How big they are
 * (smaller is bigger), how much of the sky they cover, where they sit (the sine
 * of their height above the horizon, from and to), how fast they drift, and their
 * colours, a pale blue-grey underneath going white on top (sRGB).
 */
const CLOUDS = {
    scale: 0.55,
    cover: 0.38,
    low: [0.015, 0.06],
    high: [0.18, 0.45],
    drift: 0.004,
    under: '#d6ebfb',
    top: '#ffffff',
};

/** How far off (metres) the haze takes a little under two thirds of the sea's colour. */
const HAZE = 600;

/** The wake's slick: how much paler and greener the water goes where its foam's been, under the froth. */
const SLICK = { pale: 0.3 };

/** The boat's shadow: half its width and half its length (metres). */
const SHADOW = { wide: 0.45, long: 1.25 };

/**
 * The hull, as the water sees it: its waterline's half-width and half-length
 * (metres). The water under it and near it (out to this many times its size) is
 * slid away from the eye along the line of sight, by up to this much (metres):
 * the same spot on the screen, but sorted behind the boat, so its soft edges
 * never smear across the hull, yet it's still there wherever the hull isn't.
 */
const HULL = { wide: 0.62, long: 1.6, near: 1.8, behind: 1.2 };

/* the uniforms */

/** Seconds since it started. */
const time = uniform(0);
/** Where the camera is: what the haze and the glance are measured from. */
const eye = uniform(new THREE.Vector3());
/** The boat: where it is and which way it's heading (x, z, heading). */
const boat = uniform(new THREE.Vector3());

export const colour = (hex: string): TslNode => {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
};

/* the waves */

/**
 * The sea at `xz` (where the water was before the chop moved it): each tile's
 * shape, slope and squeeze, without those too fine to show at this `footprint`
 * (metres), so the far sea doesn't shimmer, their slope counted as roughness
 * instead; the finest tile stronger or weaker by `gust`. How far it's moved (Dx,
 * up, Dz), its slope, how squeezed it is (its Jacobian, 1 untouched, under 0
 * folded over) and roughness.
 */
function seaAt(xz: TslNode, footprint: TslNode, gust: TslNode, tiles: Waves['tiles']) {
    let moved: TslNode = vec3(0);
    let slope: TslNode = vec2(0);
    let squeeze: TslNode = vec3(0);
    let rough: TslNode = float(0);
    tiles.forEach((tile, n) => {
        const uv = xz.div(tile.size);
        const shown = smoothstep(DRAWN.gone, DRAWN.full, footprint.div(tile.size / TEXELS)).toVar();
        const strength = n === tiles.length - 1 ? shown.mul(gust) : shown;
        // Read at full size: a splat's made in compute, with no derivatives to pick one by.
        const shape = texture(tile.shape, uv).level(0);
        const tilt = texture(tile.slope, uv).level(0);
        moved = moved.add(shape.xyz.mul(shown));
        slope = slope.add(tilt.xy.mul(strength));
        squeeze = squeeze.add(vec3(tilt.z, tilt.w, shape.w).mul(strength));
        rough = rough.add(shown.oneMinus().mul(tile.slope_rms ** 2));
    });
    const jacobian = squeeze.x.add(1).mul(squeeze.y.add(1)).sub(squeeze.z.mul(squeeze.z));
    return { moved, slope, jacobian, rough };
}

/** How rough the gusts make the ripples at `xz`: patches drifting with the wind. */
function gustAt(xz: TslNode): TslNode {
    const drift = vec2(Math.cos(WIND.towards), Math.sin(WIND.towards)).mul(time.mul(WIND.drift));
    return mix(
        GUSTS.calm,
        GUSTS.rough,
        smoothstep(-0.45, 0.45, mx_noise_float(vec3(xz.sub(drift).div(GUSTS.size), time.mul(0.02)))),
    );
}

/* the sky */

/** The sky seen along `dir`: deep overhead, pale at the horizon. */
export function skyGradient(dir: TslNode): TslNode {
    // (Not pow(0, …): it isn't always 0 on the GPU.)
    return mix(colour(SKY.horizon), colour(SKY.zenith), pow(max(dir.y, 1e-4), 0.6).clamp(0, 1));
}

/**
 * The whole sky seen along `dir`: its gradient, the sun's glow, the clouds on a
 * ceiling over the sea (seen in perspective, so they bunch towards the horizon),
 * and the sun's disc if asked for (the sea draws its own reflection as glitter).
 * The background, and what the sea reflects.
 */
export function skyColour(dir: TslNode, withSun: boolean): TslNode {
    const up = max(dir.y, 0.02);
    const ceiling = dir.xz
        .div(up)
        .mul(CLOUDS.scale)
        .add(vec2(time.mul(CLOUDS.drift), 0));
    const puff = mx_noise_float(vec3(ceiling, 0))
        .add(mx_noise_float(vec3(ceiling.mul(2.3), 4)).mul(0.45))
        .mul(0.5)
        .add(0.5)
        .toVar();
    const band = smoothstep(CLOUDS.low[0], CLOUDS.low[1], dir.y).mul(smoothstep(CLOUDS.high[1], CLOUDS.high[0], dir.y));
    const edge = 1 - CLOUDS.cover;
    const cloud = smoothstep(edge - 0.02, edge, puff).mul(band);
    const cloudColour = mix(colour(CLOUDS.under), colour(CLOUDS.top), smoothstep(edge, edge + 0.2, puff));
    const toSun = dot(dir, vec3(SUN.dir.x, SUN.dir.y, SUN.dir.z)).toVar();
    const glow = colour(SKY.glow).mul(pow(max(toSun, 0), SKY.glowTight).mul(SKY.glowBright));
    let sky: TslNode = skyGradient(dir).add(glow);
    if (withSun) {
        const size = SUN.size * SUN.size;
        sky = mix(sky, vec3(1, 1, 0.96), smoothstep(1 - size, 1 - size / 2, toSun));
    }
    return mix(sky, cloudColour, cloud);
}

/* the froth */

/** The wake's foam at `xz`, given how much of it is there: frothy, drifting with the wind, dense in the middle and lacy at its edges. */
const froth = Fn(([xz, wakeFoam]: [TslNode, TslNode]) => {
    const foam = float(0).toVar();
    // Only where there's wake: the noise is the dearest thing in the sea.
    If(wakeFoam.greaterThan(0.001), () => {
        const drift = vec2(Math.cos(WIND.towards), Math.sin(WIND.towards)).mul(time.mul(WIND.drift));
        const at = xz.sub(drift).div(FOAM.size).toVar();
        const broken = mx_noise_float(vec3(at, time.mul(0.15)))
            .add(mx_noise_float(vec3(at.mul(2.7), time.mul(0.3).add(5))).mul(0.5))
            .mul(0.5);
        const fine = mx_noise_float(vec3(at.mul(FOAM.fine), time.mul(0.6).add(9)));
        const amount = wakeFoam.mul(smoothstep(-0.6, 0.2, broken));
        foam.assign(amount.mul(smoothstep(0.35, 0.9, fine.mul(0.6).add(amount.mul(0.75)))).mul(FOAM.white));
    });
    return foam;
});

/* the sheet */

/** Linear light to display (sRGB), roughly: what a splat's colour is given in. */
const toDisplay = (linear: TslNode): TslNode => pow(max(linear, 0), vec3(1 / 2.2));

const N = SHEET.across;

/** One splat of the sheet: where it is, moved by the waves and the wake, and lit. */
function sheetSplat(index: TslNode, wake: Wake, waves: Waves) {
    // Which ring, and where in its grid, fixed in the world, centred on the step nearest the camera.
    const ring = index.div(uint(N * N));
    const cell = index.mod(uint(N * N));
    const ij = vec2(float(cell.mod(uint(N))), float(cell.div(uint(N))));
    const spacing = exp2(float(ring)).mul(SHEET.spacing).toVar();
    const xz = round(eye.xz.div(spacing))
        .mul(spacing)
        .add(ij.sub(N / 2 - 0.5).mul(spacing))
        .toVar();

    // Handed from ring to ring across a band, not at a line: over the last stretch of a ring its
    // splats fade out as the next ring's fade in, both near solid in the middle so nothing shows
    // through. Inside the band, only the finer ring draws.
    const reach = (centre: TslNode, half: TslNode) => {
        const off = abs(xz.sub(centre));
        return max(off.x, off.y).div(half);
    };
    const own = reach(round(eye.xz.div(spacing)).mul(spacing), spacing.mul(N / 2));
    const inner = spacing.mul(0.5);
    const fromInner = reach(round(eye.xz.div(inner)).mul(inner), inner.mul(N / 2));
    const fadeOut = ring.lessThan(uint(SHEET.rings - 1)).select(smoothstep(SHEET.handover[1], SHEET.handover[0], own), float(1));
    const fadeIn = ring.greaterThan(uint(0)).select(smoothstep(SHEET.handover[0], SHEET.handover[1], fromInner), float(1));
    // How far out from the hull's waterline this is (1 on it): none drawn inside, small near it.
    const forward = vec2(sin(boat.z), cos(boat.z).negate());
    const fromBoat = xz.sub(boat.xy);
    const hull = vec2(dot(fromBoat, vec2(forward.y.negate(), forward.x)).div(HULL.wide), dot(fromBoat, forward).div(HULL.long))
        .length()
        .toVar();
    const share = fadeOut.mul(fadeIn).toVar();

    // The wake and the waves here, as finely as the sheet this far off can show them. By the
    // distance, not this ring's own spacing, so two rings agree where they meet: no seam.
    const wakeAt = wake.at(xz).toVar();
    const gust = gustAt(xz).mul(wakeAt.w.min(1).mul(-0.7).add(1));
    const footprint = max(
        eye.xz
            .sub(xz)
            .length()
            .mul(SHEET.footprint / N),
        SHEET.spacing,
    );
    const sea = seaAt(xz, footprint, gust, waves.tiles);
    const at = vec3(xz.x, 0, xz.y)
        .add(sea.moved)
        .add(vec3(0, wakeAt.x, 0))
        .toVar();
    const slope = sea.slope.add(wakeAt.yz);
    const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate())).toVar();
    const up = sea.moved.y.toVar();
    const sun = vec3(SUN.dir.x, SUN.dir.y, SUN.dir.z);
    const toEye = eye.sub(at).toVar();
    const distance = toEye.length().toVar();
    const view = toEye.div(distance).toVar();

    // The sky reflected, by Fresnel: a little looking straight down, nearly all at a glance.
    const facing = max(dot(normal, view), 0).toVar();
    const fresnel = pow(facing.oneMinus(), 5).mul(0.98).add(0.02).min(WATER.reflects);
    const bounced = reflect(view.negate(), normal);
    const mirrored = normalize(vec3(bounced.x, max(bounced.y, 0.01), bounced.z)).toVar();
    const sky = skyColour(mirrored, false);

    // The sun's glitter: its disc smeared over the slopes too fine to show here, which turn
    // the reflection twice as far. The same light spread wider is dimmer.
    const spread = sea.rough
        .mul(4)
        .add(SUN.size * SUN.size)
        .toVar();
    const offSun = float(2).sub(dot(mirrored, sun).mul(2));
    const glitter = exp(offSun.div(spread.mul(-2)))
        .mul(SUN.glitter / (2 * Math.PI))
        .div(spread);

    // What comes up out of the water: deep blue-green, darker on the side away from the sun,
    // and teal where the light comes through the crests, more of it looking towards the sun.
    const lit = mix(WATER.away, 1, smoothstep(-0.1, 0.5, dot(normal, sun)));
    const towards = max(dot(view.negate().xz.normalize(), sun.xz.normalize()), 0);
    const through = smoothstep(WATER.throughFrom[0], WATER.throughFrom[1], up).mul(
        towards.mul(WATER.towardsSun).add(1 - WATER.towardsSun),
    );
    const below = mix(colour(WATER.deep).mul(lit), colour(WATER.through), through.mul(WATER.throughShare));

    // The boat's shadow, cast down the sun onto the water: nothing comes up there, but it
    // still reflects the sky.
    const cast = vec2(SUN.dir.x, SUN.dir.z).mul(SUN.castFrom / SUN.dir.y);
    const fromShadow = xz.sub(boat.xy.sub(cast));
    const inShadow = vec2(
        dot(fromShadow, vec2(forward.y.negate(), forward.x)).div(SHADOW.wide),
        dot(fromShadow, forward).div(SHADOW.long),
    );
    const shadow = smoothstep(1.15, 0.85, inShadow.length());
    const water = mix(below.mul(mix(1, WATER.shadow, shadow)), sky, fresnel).add(
        vec3(1, 0.97, 0.9).mul(glitter.mul(fresnel).mul(shadow.oneMinus())),
    );

    // Foam: whitecaps where the chop folds the crests over, and the wake's, over its slick.
    const caps = smoothstep(CAPS.from, CAPS.full, sea.jacobian.add(gust.sub(1).mul(CAPS.broken)));
    const foam = froth(xz, max(caps, wakeAt.w));
    const slicked = mix(water, colour(WATER.through).mul(1.15), wakeAt.w.min(1).mul(SLICK.pale));
    const foamLit = colour(FOAM.colour)
        .mul(lit.mul(0.25).add(0.75))
        .mul(mix(1, 0.75, shadow));
    const surface = mix(slicked, foamLit, foam);

    // A flat disc along the surface: its thin axis, y, turned onto the normal.
    const quaternion = normalize(vec4(normal.z, 0, normal.x.negate(), normal.y.add(1)));
    // Under and near the hull, slid back along the line of sight (and grown to match, so it
    // covers the same spot on the screen), to sort behind the boat.
    const behind = smoothstep(HULL.near, 1, hull).mul(HULL.behind);
    const grown = distance.add(behind).div(distance);
    const wide = spacing.mul(SHEET.wide).mul(grown);
    return GpuSplats.Splat(
        at.sub(view.mul(behind)),
        vec3(wide, wide.mul(SHEET.thin), wide),
        quaternion,
        // Splats take display (sRGB) colours: the light's linear until here.
        toDisplay(mix(colour(SKY.horizon), surface, exp(distance.div(-HAZE)))),
        share.greaterThan(0.01).select(share.mul(2).min(1).mul(SHEET.solid), float(0)),
        uint(index),
    );
}

/** The sheet's splats drawn round `camera`: every ring's grid, less the middle the ring inside has to itself. */
function sheetCount(camera: THREE.Vector3): number {
    let total = N * N;
    for (let ring = 1; ring < SHEET.rings; ring++) {
        const spacing = SHEET.spacing * 2 ** ring;
        const inner = spacing / 2;
        const hiddenAlong = (at: number) => {
            const centre = Math.round(at / spacing) * spacing;
            const innerCentre = Math.round(at / inner) * inner;
            let n = 0;
            for (let i = 0; i < N; i++) {
                const x = centre + (i - N / 2 + 0.5) * spacing;
                if (Math.abs(x - innerCentre) < ((inner * N) / 2) * SHEET.handover[0]) n++;
            }
            return n;
        };
        total += N * N - hiddenAlong(camera.x) * hiddenAlong(camera.z);
    }
    return total;
}

/* the sea */

export type Sea = {
    objects: SplatObject[];
    /** How many splats the sheet draws round this camera. */
    count: (camera: THREE.Vector3) => number;
    /** The boat's here, heading this way: for its shadow. */
    boatAt: (x: number, z: number, heading: number) => void;
    update: (elapsed: number, camera: THREE.Vector3) => void;
};

export function initSea(wake: Wake, waves: Waves): Sea {
    const sheet = SplatCollection.object({
        count: SHEET.rings * N * N,
        generator: { generateSplat: (index: TslNode) => sheetSplat(index, wake, waves) },
        params: { lodInflate: false },
    });
    return {
        objects: [sheet],
        count: sheetCount,
        boatAt(x, z, heading) {
            boat.value.set(x, z, heading);
        },
        update(elapsed, camera) {
            time.value = elapsed;
            eye.value.copy(camera);
        },
    };
}
