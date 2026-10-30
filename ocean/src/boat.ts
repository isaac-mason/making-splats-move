/**
 * The boat: a little toon sloop, built once out of a few thousand small crisp
 * splats, then floated and steered on the CPU.
 *
 * It's built in its own frame, bow towards -z, the waterline at 0, each surface
 * sampled densely with flat discs laid along it, each a flat toon colour, a step
 * darker where it faces away from the light:
 * - the hull: a round-bilged red hull, a white band under the sheer with a navy
 *   pinstripe, a flat transom, a teak rail along the gunwale, the inside of the
 *   bulwarks cream;
 * - the deck: plain teak;
 * - a cabin: cream walls with portholes, a blue roof, a red life ring on its back;
 * - the rig: a mast and boom, a mainsail with a teal band,
 *   a jib, the forestay and shrouds, and a red pennant at the masthead;
 * - a rudder and tiller at the stern.
 * What's under the water is hidden by the sea.
 *
 * Afloat, it samples the swell (sea.ts, the same sum the water's drawn with) at
 * its bow, stern and either side, and eases its height, pitch and roll to them,
 * leaning into its turns and lifting its bow a little with speed. W/S (or the
 * arrows) sail and slow, A/D steer.
 *
 * Sections: settings · splats · the hull · the deck and cabin · the rig · building it · afloat.
 */

import { type AnySplatObject, GpuArrays, SplatCollection, Splats } from '@sparkjsdev/radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

/* settings */

/** How far apart the splats are on a surface (metres): small enough that the boat's crisp up close. */
const SPACING = 0.018;

/**
 * The hull: how long (metres, bow to transom), how wide at its widest, and where
 * that is (a share along it, from the middle, aft); how deep from the gunwale to
 * the keel amidships; how high the gunwale stands over the water and how much it
 * rises to the bow (its sheer). How wide the white band under the gunwale is and
 * the pinstripe under that (metres).
 */
const HULL = { length: 3.3, beam: 1.36, widest: 0.1, depth: 0.72, freeboard: 0.42, sheer: 0.22, band: 0.09, pinstripe: 0.02 };

/** The deck: how far below the gunwale (metres), and its planks' width. */
const DECK = { below: 0.07, plank: 0.09 };

/** The cabin: from and to along the boat (z), how wide, how tall over the deck, and its roof's rise. */
const CABIN = { from: -0.35, to: 0.45, wide: 0.78, tall: 0.4, arch: 0.05 };

/**
 * The rig: where the mast stands (z), how tall it is and thick; how high the
 * boom is and where it reaches back to (z); how far the mainsail and jib belly
 * out to port (metres); where the jib's clew is.
 */
const RIG = {
    mast: -0.6,
    height: 3.4,
    radius: 0.04,
    boom: 1.2,
    boomTo: 1.4,
    belly: 0.14,
    jibBelly: 0.1,
    jibClew: [-0.32, 0.8, -0.3],
};

/** The colours, sRGB. */
const PAINT = {
    hull: '#c9432b',
    band: '#f4eddc',
    pinstripe: '#24365f',
    rail: '#9a663a',
    bulwark: '#efe6d2',
    deck: '#d6ad76',
    cabin: '#f6f0e2',
    roof: '#2e7cb2',
    porthole: '#27395e',
    mast: '#eadcc0',
    sail: '#fbf5e7',
    sailBand: '#2ea39b',
    rigging: '#4a4d55',
    pennant: '#e2412c',
    ring: '#e2412c',
    rudder: '#9a663a',
};

/** The light the toon shading is worked from, in the boat's frame: up, and a little to starboard and aft. */
const LIGHT = new THREE.Vector3(0.4, 0.82, 0.4).normalize();
/** How much darker a face turned from the light is. */
const SHADE = 0.78;

/**
 * How it sails: top speed ahead and astern (m/s), how fast it gets there and
 * coasts back (m/s²), how fast it turns at speed (radians a second), and how
 * much it still turns when barely moving.
 */
const SAIL = { ahead: 7, astern: 1.5, gather: 1.8, coast: 0.8, turn: 0.9, crawl: 0.3 };

/**
 * How it floats: where it feels the water (metres ahead and astern, and either
 * side); how quickly it follows the swell (per second); how far it sits down in
 * the water; how far it leans into a turn and lifts its bow at speed (radians).
 */
const FLOAT = { reach: 1.3, side: 0.55, follow: 10, sink: 0.02, lean: 0.12, lift: 0.05 };

/* splats */

type Splat = { at: THREE.Vector3; scales: THREE.Vector3; quaternion: THREE.Quaternion; colour: THREE.Color };

/** A crisp splat (opacity past 1, lodInflate off) is solid out to about this many standard deviations: its radius. */
const DISC = 1.8;
const Y = new THREE.Vector3(0, 1, 0);

/** Toon-shaded: the colour, a step darker if `normal` faces from the light. */
const toon = (hex: string, normal: THREE.Vector3) => new THREE.Color(hex).multiplyScalar(normal.dot(LIGHT) > 0.05 ? 1 : SHADE);

/** A disc of this radius at `at`, lying flat across `normal`. */
function disc(out: Splat[], at: THREE.Vector3, normal: THREE.Vector3, radius: number, colour: THREE.Color) {
    const n = normal.clone().normalize();
    const sigma = radius / DISC;
    out.push({
        at: at.clone(),
        scales: new THREE.Vector3(sigma, sigma * 0.1, sigma),
        quaternion: new THREE.Quaternion().setFromUnitVectors(Y, n),
        colour,
    });
}

/**
 * A surface `at(u, v)` (u and v 0..1) covered in discs about `SPACING` apart, each
 * coloured by `paint(u, v, normal)`. Its normal is worked out from the surface,
 * and turned outwards from `inside` if given.
 */
function surface(
    out: Splat[],
    at: (u: number, v: number) => THREE.Vector3,
    paint: (u: number, v: number, normal: THREE.Vector3, p: THREE.Vector3) => THREE.Color | null,
    inside?: (p: THREE.Vector3) => THREE.Vector3,
    wraps = false,
    boundary?: (p: THREE.Vector3) => number,
) {
    // How many along each way: from the surface's length along its middle lines.
    const lengthAlong = (f: (t: number) => THREE.Vector3) => {
        let total = 0;
        for (let i = 0; i < 32; i++) total += f(i / 32).distanceTo(f((i + 1) / 32));
        return total;
    };
    const nu = Math.max(
        2,
        Math.ceil(
            Math.max(
                lengthAlong((t) => at(t, 0.5)),
                lengthAlong((t) => at(t, 0.05)),
            ) / SPACING,
        ),
    );
    const nv = Math.max(
        2,
        Math.ceil(
            Math.max(
                lengthAlong((t) => at(0.5, t)),
                lengthAlong((t) => at(0.05, t)),
            ) / SPACING,
        ),
    );
    const e = 1e-3;
    for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++) {
            const u = (i + 0.5) / nu;
            const v = (j + 0.5) / nv;
            const p = at(u, v);
            const du = at(Math.min(u + e, 1), v).sub(at(Math.max(u - e, 0), v));
            const dv = at(u, Math.min(v + e, 1)).sub(at(u, Math.max(v - e, 0)));
            const normal = new THREE.Vector3().crossVectors(du, dv).normalize();
            if (inside && normal.dot(p.clone().sub(inside(p))) < 0) normal.negate();
            const colour = paint(u, v, normal, p);
            if (!colour) continue;
            // Big enough to cover the gaps to its neighbours, however the grid's stretched here
            // (never more than a couple of spacings: where a surface pinches to a point, it can't tell).
            const stretch = Math.max(du.length() / (2 * e) / nu, dv.length() / (2 * e) / nv);
            // Kept inside the surface's edges, so they're crisp lines, not a fuzz of discs spilling
            // over (round the way it closes on itself, if it does, there's no edge).
            const toEdgeU = Math.min(u, 1 - u) * (du.length() / (2 * e));
            const toEdgeV = wraps ? Number.POSITIVE_INFINITY : Math.min(v, 1 - v) * (dv.length() / (2 * e));
            // And inside any painted shape's outline (`boundary`, metres to it), so it's crisp too.
            const edge = Math.min(toEdgeU, toEdgeV, boundary ? boundary(p) : Number.POSITIVE_INFINITY) * 1.3;
            const radius = Math.min(
                THREE.MathUtils.clamp(stretch * 1.05, SPACING * 0.4, SPACING * 2),
                Math.max(edge, SPACING * 0.3),
            );
            disc(out, p, normal, radius, colour);
        }
    }
}

/** A thin line from `a` to `b`, this thick (its radius): a chain of long round splats, smooth from any side. */
function line(out: Splat[], a: THREE.Vector3, b: THREE.Vector3, thick: number, hex: string) {
    const dir = b.clone().sub(a);
    const length = dir.length();
    const steps = Math.ceil(length / SPACING);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
    for (let i = 0; i < steps; i++) {
        out.push({
            at: a.clone().lerp(b, (i + 0.5) / steps),
            // Each overlapping the next, so the line's unbroken.
            scales: new THREE.Vector3((length / steps / DISC) * 1.3, thick / DISC, thick / DISC),
            quaternion,
            colour: new THREE.Color(hex),
        });
    }
}

/** A round spar from `a` to `b`, this thick: rings of discs round it. */
function spar(out: Splat[], a: THREE.Vector3, b: THREE.Vector3, radius: number, hex: string) {
    const dir = b.clone().sub(a).normalize();
    const side = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? Y : new THREE.Vector3(1, 0, 0)).normalize();
    const other = new THREE.Vector3().crossVectors(dir, side);
    surface(
        out,
        (u, v) => {
            const angle = v * Math.PI * 2;
            return a
                .clone()
                .lerp(b, u)
                .addScaledVector(side, Math.cos(angle) * radius)
                .addScaledVector(other, Math.sin(angle) * radius);
        },
        (_u, _v, normal) => toon(hex, normal),
        (p) => {
            const t = p.clone().sub(a).dot(dir);
            return a.clone().addScaledVector(dir, t);
        },
        true,
    );
}

/* the hull */

/** Along the hull, u from -1 at the bow to 1 at the transom: where that is (z). */
const zAt = (u: number) => (u * HULL.length) / 2 - 0.05;
/** The hull's half-width at u. */
const halfWidth = (u: number) => (HULL.beam / 2) * Math.sqrt(Math.max(1 - ((u - HULL.widest) / (1 + HULL.widest)) ** 2, 0));
/** The gunwale's height at u: rising to the bow. */
const gunwale = (u: number) => HULL.freeboard + HULL.sheer * Math.max(-u, 0) ** 2 + 0.04 * u * u;
/** How far below the gunwale the keel is at u. */
const depthAt = (u: number) => HULL.depth * (1 - 0.4 * u * u);
/** The transom's at u = 0.92: the hull's cut off square there. */
const TRANSOM = 0.92;

/** A point on the hull's skin: u along it, v round it from port gunwale (0) through the keel to starboard (1). */
function hullAt(u: number, v: number): THREE.Vector3 {
    const phi = (v - 0.5) * Math.PI;
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    // A full, round-bilged section: a superellipse.
    const x = halfWidth(u) * Math.sign(s) * Math.abs(s) ** 0.6;
    const y = gunwale(u) - depthAt(u) * Math.abs(c) ** 0.75;
    return new THREE.Vector3(x, y, zAt(u));
}

function hull(out: Splat[]) {
    const toU = (t: number) => -1 + t * (1 + TRANSOM);
    const paint = (u: number, p: THREE.Vector3, normal: THREE.Vector3) => {
        const below = gunwale(u) - p.y;
        if (below < HULL.band) return toon(PAINT.band, normal);
        if (below < HULL.band + HULL.pinstripe) return toon(PAINT.pinstripe, normal);
        return toon(PAINT.hull, normal);
    };
    surface(
        out,
        (t, v) => hullAt(toU(t), v),
        (t, _v, normal, p) => paint(toU(t), p, normal),
        (p) => new THREE.Vector3(0, p.y + 0.3, p.z),
    );
    // The transom: flat across the stern, filled in from the hull's edge up to the gunwale.
    surface(
        out,
        (t, v) => {
            const edge = hullAt(TRANSOM, v);
            return edge.clone().lerp(new THREE.Vector3(edge.x, gunwale(TRANSOM), edge.z), t);
        },
        (_t, _v, _n, p) => paint(TRANSOM, p, new THREE.Vector3(0, 0, 1)),
    );
    // The inside of the bulwarks, from the gunwale down to the deck.
    surface(
        out,
        (t, v) => {
            const u = toU(t);
            const side = v < 0.5 ? -1 : 1;
            const drop = (v < 0.5 ? v : 1 - v) * 2 * DECK.below;
            return new THREE.Vector3(side * halfWidth(u) * 0.97, gunwale(u) - drop, zAt(u));
        },
        (_t, v) => toon(PAINT.bulwark, new THREE.Vector3(v < 0.5 ? 1 : -1, 0, 0)),
    );
    // The rail: a teak cap along each gunwale.
    for (const side of [-1, 1]) {
        surface(
            out,
            (t, v) => {
                const u = toU(t);
                return new THREE.Vector3(side * (halfWidth(u) - 0.03 + v * 0.06), gunwale(u) + 0.012, zAt(u));
            },
            (_t, _v, normal) => toon(PAINT.rail, normal.y < 0 ? normal.negate() : normal),
        );
    }
}

/* the deck and cabin */

function deck(out: Splat[]) {
    const toU = (t: number) => -0.97 + t * (0.97 + TRANSOM);
    const up = new THREE.Vector3(0, 1, 0);
    // One clean teak colour.
    surface(
        out,
        (t, v) => {
            const u = toU(t);
            return new THREE.Vector3((v - 0.5) * 2 * halfWidth(u) * 0.97, gunwale(u) - DECK.below, zAt(u));
        },
        (_t, _v, _n, p) => {
            const inCabin = p.z > CABIN.from && p.z < CABIN.to && Math.abs(p.x) < CABIN.wide / 2;
            if (inCabin) return null;
            return toon(PAINT.deck, up);
        },
    );
}

/** A porthole's radius (metres). */
const PORTHOLE = 0.045;

function cabin(out: Splat[]) {
    const base = (z: number) => gunwale((z + 0.05) / (HULL.length / 2)) - DECK.below;
    const floor = Math.min(base(CABIN.from), base(CABIN.to));
    const top = floor + CABIN.tall;
    const half = CABIN.wide / 2;
    const middle = new THREE.Vector3(0, floor + CABIN.tall / 2, (CABIN.from + CABIN.to) / 2);
    const porthole = floor + CABIN.tall * 0.45;
    const portholes = [-0.2, 0.1, 0.35].map((z) => CABIN.from + (CABIN.to - CABIN.from) * (0.5 + z * 0.9));
    /** How far `p` is outside the nearest porthole's rim (metres; under 0 inside it). */
    const toPorthole = (p: THREE.Vector3) => Math.min(...portholes.map((z) => Math.hypot(p.z - z, p.y - porthole))) - PORTHOLE;
    // Its sides, with round portholes along them.
    for (const side of [-1, 1]) {
        surface(
            out,
            (t, v) => new THREE.Vector3(side * half, floor + v * CABIN.tall, CABIN.from + t * (CABIN.to - CABIN.from)),
            // Round portholes painted on, the wall's splats shrinking along their rims so they're crisp.
            (_t, _v, normal, p) => toon(toPorthole(p) < 0 ? PAINT.porthole : PAINT.cabin, normal),
            () => middle,
            false,
            (p) => Math.abs(toPorthole(p)),
        );
    }
    // Its front and back.
    for (const z of [CABIN.from, CABIN.to]) {
        surface(
            out,
            (t, v) => new THREE.Vector3((t - 0.5) * CABIN.wide, floor + v * CABIN.tall, z),
            (_t, _v, normal) => toon(PAINT.cabin, normal),
            () => middle,
        );
    }
    // Its roof, arched a little, overhanging.
    surface(
        out,
        (t, v) => {
            const x = (t - 0.5) * (CABIN.wide + 0.06);
            return new THREE.Vector3(
                x,
                top + CABIN.arch * (1 - (x / (half + 0.03)) ** 2),
                CABIN.from - 0.03 + v * (CABIN.to - CABIN.from + 0.06),
            );
        },
        (_t, _v, normal) => toon(PAINT.roof, normal.y < 0 ? normal.negate() : normal),
    );
    // A life ring hung on its back, all red: flat, held a little off the wall, and one colour, so
    // however its splats are sorted as the boat turns, it reads the same.
    const centre = new THREE.Vector3(0, floor + CABIN.tall * 0.5, CABIN.to + 0.05);
    surface(
        out,
        (t, v) => {
            const around = t * Math.PI * 2;
            const r = 0.09 + v * 0.06;
            return new THREE.Vector3(Math.cos(around) * r, Math.sin(around) * r, 0).add(centre);
        },
        () => toon(PAINT.ring, new THREE.Vector3(0, 0.3, 1).normalize()),
    );
}

/* the rig */

/**
 * A sail: a triangle from its tack (where its foot meets its luff) up to its head
 * and back to its clew, bellying out by `belly` along `outwards`, fullest a third
 * of the way back. `paint` colours it from its height up the luff (0..1).
 */
function sail(
    out: Splat[],
    tack: THREE.Vector3,
    head: THREE.Vector3,
    clew: THREE.Vector3,
    belly: number,
    outwards: THREE.Vector3,
    paint: (up: number) => string,
) {
    surface(
        out,
        (a, b) => {
            // a up the luff, b back along the chord: a triangle, its chords shrinking to the head.
            const luff = tack.clone().lerp(head, a);
            const leech = clew.clone().lerp(head, a);
            const chord = b;
            const fill = Math.sin(Math.PI * chord ** 0.75) * belly * (1 - a * 0.7);
            return luff.lerp(leech, chord).addScaledVector(outwards, fill);
        },
        // Cloth: the light comes through it, so it's lit from whichever side the light's on.
        (a, _b, normal) => toon(paint(a), normal.dot(LIGHT) < 0 ? normal.clone().negate() : normal),
    );
}

function rig(out: Splat[]) {
    const deckAt = (z: number) => gunwale((z + 0.05) / (HULL.length / 2)) - DECK.below;
    const foot = new THREE.Vector3(0, deckAt(RIG.mast), RIG.mast);
    const head = new THREE.Vector3(0, RIG.height, RIG.mast);
    spar(out, foot, head, RIG.radius, PAINT.mast);
    const boomFrom = new THREE.Vector3(0, RIG.boom, RIG.mast + 0.03);
    const boomTo = new THREE.Vector3(-0.25, RIG.boom, RIG.boomTo);
    spar(out, boomFrom, boomTo, RIG.radius * 0.75, PAINT.mast);

    // The mainsail, its panels' seams across it and a teal band near its foot.
    const port = new THREE.Vector3(-1, 0, 0);
    sail(
        out,
        new THREE.Vector3(0, RIG.boom + 0.05, RIG.mast + 0.05),
        new THREE.Vector3(0, RIG.height - 0.12, RIG.mast + 0.05),
        boomTo.clone().add(new THREE.Vector3(0, 0.05, 0)),
        RIG.belly,
        port,
        (up) => (up > 0.1 && up < 0.16 ? PAINT.sailBand : PAINT.sail),
    );
    // The jib, from the stemhead up the forestay, its clew out to port.
    const stem = hullAt(-0.98, 0.5).setY(gunwale(-0.98) + 0.02);
    const jibHead = new THREE.Vector3(0, RIG.height * 0.82, RIG.mast - 0.04);
    sail(
        out,
        stem.clone().add(new THREE.Vector3(0, 0.1, 0.06)),
        jibHead,
        new THREE.Vector3(...RIG.jibClew),
        RIG.jibBelly,
        port,
        () => PAINT.sail,
    );

    // The forestay and the shrouds.
    const masthead = new THREE.Vector3(0, RIG.height - 0.05, RIG.mast);
    line(out, stem, masthead, 0.006, PAINT.rigging);
    for (const side of [-1, 1]) {
        const u = (RIG.mast + 0.05) / (HULL.length / 2);
        line(out, new THREE.Vector3(side * halfWidth(u), gunwale(u), RIG.mast + 0.08), masthead, 0.005, PAINT.rigging);
    }

    // A pennant at the masthead, streaming aft and tapering.
    surface(
        out,
        (t, v) => new THREE.Vector3(0, RIG.height + 0.02 - (v - 0.5) * 0.09 * (1 - t), RIG.mast + 0.02 + t * 0.32),
        (_t, _v, normal) => toon(PAINT.pennant, normal),
    );

    // The rudder hung on the transom, and its tiller over the stern.
    const transomZ = zAt(TRANSOM);
    surface(
        out,
        (t, v) => new THREE.Vector3(0, gunwale(TRANSOM) + 0.06 - v * 0.55, transomZ + 0.02 + t * 0.16 * (0.6 + v * 0.4)),
        (_t, _v, normal) => toon(PAINT.rudder, normal),
    );
    line(
        out,
        new THREE.Vector3(0, gunwale(TRANSOM) + 0.08, transomZ + 0.08),
        new THREE.Vector3(0, gunwale(TRANSOM) + 0.14, transomZ - 0.55),
        0.035,
        PAINT.rudder,
    );
}

/* building it */

/** The boat's splats, in its own frame, onto the GPU. */
function build(renderer: WebGPURenderer): GpuArrays {
    const splats: Splat[] = [];
    hull(splats);
    deck(splats);
    cabin(splats);
    rig(splats);
    const data = Splats.make(splats.length);
    const encode = Splats.encoder(Splats.get(data).bundle);
    const s = Splats.makeExtSplat();
    splats.forEach((splat, i) => {
        [s.center.x, s.center.y, s.center.z] = [splat.at.x, splat.at.y, splat.at.z];
        [s.scales.x, s.scales.y, s.scales.z] = [splat.scales.x, splat.scales.y, splat.scales.z];
        [s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w] = [
            splat.quaternion.x,
            splat.quaternion.y,
            splat.quaternion.z,
            splat.quaternion.w,
        ];
        // Splats take display (sRGB) colours; three's are linear.
        const display = splat.colour.clone().convertLinearToSRGB();
        [s.rgb.r, s.rgb.g, s.rgb.b] = [display.r, display.g, display.b];
        // Crisp: past opaque, its Gaussian's solid nearly to its edge.
        s.opacity = 2;
        encode(i, s);
    });
    return GpuArrays.fromData(renderer, data);
}

/* afloat */

export type Boat = {
    object: AnySplatObject;
    count: number;
    /** Where it is and which way it's heading (radians; 0 is -z, turning towards +x), and how fast. */
    holder: THREE.Object3D;
    heading: () => number;
    speed: () => number;
    /** Where it feels the water now: its bow, stern, port, starboard and middle (x, z). */
    feels: () => [number, number][];
    /** Sail on, floating on the water's heights where it felt it (a frame or two ago). */
    update: (dt: number, heights: number[]) => void;
};

export function initBoat(renderer: WebGPURenderer): Boat {
    const arrays = build(renderer);
    const holder = new THREE.Object3D();
    holder.rotation.order = 'YXZ';
    // Crisp (opacity past 1, lodInflate off): it reads as a solid thing among the soft water.
    const object = SplatCollection.arrays(arrays, { matrixWorld: holder.matrixWorld, params: { lodInflate: false } });

    const keys = new Set<string>();
    window.addEventListener('keydown', (event) => keys.add(event.key.toLowerCase()));
    window.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
    window.addEventListener('blur', () => keys.clear());
    const held = (...names: string[]) => names.some((name) => keys.has(name));

    let heading = 0;
    let speed = 0;
    let turning = 0;
    const position = new THREE.Vector3();
    const easeTo = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));

    return {
        object,
        count: arrays.count,
        holder,
        heading: () => heading,
        speed: () => speed,
        feels() {
            const forward = { x: Math.sin(heading), z: -Math.cos(heading) };
            const right = { x: Math.cos(heading), z: Math.sin(heading) };
            const at = (ahead: number, side: number): [number, number] => [
                position.x + forward.x * ahead + right.x * side,
                position.z + forward.z * ahead + right.z * side,
            ];
            return [at(FLOAT.reach, 0), at(-FLOAT.reach, 0), at(0, -FLOAT.side), at(0, FLOAT.side), at(0, 0)];
        },
        update(dt, heights) {
            // Sailing: gathering way and coasting, steering harder the faster it goes.
            const throttle = (held('w', 'arrowup') ? 1 : 0) - (held('s', 'arrowdown') ? 1 : 0);
            const want = throttle > 0 ? SAIL.ahead : throttle < 0 ? -SAIL.astern : 0;
            const rate = throttle !== 0 ? SAIL.gather : SAIL.coast;
            speed += Math.sign(want - speed) * Math.min(Math.abs(want - speed), rate * dt);
            const steer = (held('d', 'arrowright') ? 1 : 0) - (held('a', 'arrowleft') ? 1 : 0);
            const grip = Math.max(Math.min(Math.abs(speed) / 3, 1), SAIL.crawl);
            turning = easeTo(turning, steer * SAIL.turn * grip * Math.sign(speed || 1), 3, dt);
            heading += turning * dt;
            const forward = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading));
            position.addScaledVector(forward, speed * dt);

            // Afloat: on the water at its bow, stern and sides, easing to it.
            const [bow = 0, stern = 0, port = 0, starboard = 0, middle = 0] = heights;
            // Riding up over a crest passing under it, rather than letting it wash over the deck.
            const height = Math.max((bow + stern + port + starboard) / 4, middle) - FLOAT.sink;
            const pitch = Math.atan2(bow - stern, 2 * FLOAT.reach) + (FLOAT.lift * Math.max(speed, 0)) / SAIL.ahead;
            const roll = Math.atan2(starboard - port, 2 * FLOAT.side) - (turning / SAIL.turn) * FLOAT.lean;
            position.y = easeTo(position.y, height, FLOAT.follow, dt);
            holder.position.copy(position);
            holder.rotation.set(
                easeTo(holder.rotation.x, pitch, FLOAT.follow, dt),
                -heading,
                easeTo(holder.rotation.z, roll, FLOAT.follow, dt),
            );
            holder.updateMatrixWorld();
        },
    };
}
