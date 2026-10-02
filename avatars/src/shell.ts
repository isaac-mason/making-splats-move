import * as THREE from 'three';

/**
 * Building splat geometry out of primitives — spheres, capsules, ellipsoids.
 *
 * SURFACE SHELLS, not filled volumes. A real capture is a crust of flat discs lying
 * tangent to the photographed surface, and imitating that is most of what makes
 * procedural splats look like splats rather than a cloud of beads.
 *
 * It matters for the skinning test too: a tangent disc has a strong orientation, so
 * a bone transform that drops rotation shatters the surface into confetti, where
 * round blobs would quietly look fine.
 */

/**
 * Colour for a splat. The conversion is not optional.
 *
 * Spark's shader runs `srgbToLinear(rgba.rgb)`, so it wants sRGB. three.js does the
 * opposite: `new THREE.Color('#c1875a')` hands back the LINEAR value. Push that
 * straight in and it's linearised twice — skin tones go to mud while saturated reds
 * survive, which looks like a lighting problem rather than the encoding bug it is.
 */
/**
 * Saturation boost applied to every avatar colour, pushing each channel away from
 * the colour's own grey. 1 = as authored, which is right for the hand-picked cast;
 * raise it to punch everything up at once.
 */
const VIBRANCE = 1;

function vibrant(color: THREE.Color): THREE.Color {
    const grey = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    const push = (c: number) => THREE.MathUtils.clamp(grey + (c - grey) * VIBRANCE, 0, 1);
    return color.setRGB(push(color.r), push(color.g), push(color.b));
}

export function splatColor(style: string | number): THREE.Color {
    return vibrant(new THREE.Color(style).convertLinearToSRGB());
}

export function splatColorHSL(h: number, s: number, l: number): THREE.Color {
    return vibrant(new THREE.Color().setHSL(h, s, l).convertLinearToSRGB());
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Lattice scatter, as a fraction of spacing.
 *
 * The Fibonacci lattice is *too* regular: stack two shells and the patterns interfere
 * into a moiré that reads as woven fabric, glaring on something large and dark like
 * hair. Deterministic, so a seed always builds the same character.
 */
const JITTER = 0.4;

let noiseState = 1;
function resetNoise(seed: number) {
    noiseState = seed >>> 0 || 1;
}
function noise() {
    noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
    return noiseState / 0x100000000 - 0.5;
}

const jitterA = new THREE.Vector3();
const jitterB = new THREE.Vector3();

/** Scatter a point within its own tangent plane, so it stays on the surface. */
function jitter(shell: Shell, point: THREE.Vector3, normal: THREE.Vector3, spacing: number): void {
    const amount = spacing * shell.settings.jitter;
    if (amount <= 0) return;
    jitterA.set(normal.z, normal.x, normal.y).cross(normal).normalize();
    jitterB.copy(normal).cross(jitterA);
    point.addScaledVector(jitterA, noise() * amount);
    point.addScaledVector(jitterB, noise() * amount);
}

/** How flat each disc is, as a fraction of its in-plane size. */
const FLATNESS = 0.16;

export type ShellSettings = {
    /** Disc radius over sampling spacing. See the note on OVERLAP below. */
    overlap: number;
    /** Lattice scatter, as a fraction of spacing. See JITTER below. */
    jitter: number;
};
/**
 * Disc radius relative to sampling spacing — the sharpness dial, and it fights
 * coverage. Too wide and the surface is fog, too narrow and it's specks. The cure for
 * wanting both is closer sampling, not this number.
 */
const OVERLAP = 0.52;

export type Shell = {
    settings: ShellSettings;
    centers: THREE.Vector3[];
    quats: THREE.Quaternion[];
    scales: THREE.Vector3[];
    colors: THREE.Color[];
    /** Which bone this splat was authored as part of. See avatar.ts for why that matters. */
    owners: number[];
};

const Z = new THREE.Vector3(0, 0, 1);

export function createShell(seed = 1, settings: ShellSettings = { overlap: OVERLAP, jitter: JITTER }): Shell {
    resetNoise(seed * 2654435761);
    return { settings, centers: [], quats: [], scales: [], colors: [], owners: [] };
}

/** One tangent disc at `center`, lying perpendicular to `normal`. */
function addDisc(
    shell: Shell,
    center: THREE.Vector3,
    normal: THREE.Vector3,
    spacing: number,
    color: THREE.Color,
    owner: number,
    /**
     * Fatten the discs without moving them closer together.
     *
     * Coverage depends only on disc-size-over-spacing, so sampling a decal more
     * finely doesn't help — both shrink together. A curved surface stacks shells
     * inward; a decal is flat, so overlap is the only lever left.
     */
    sizeScale = 1,
): void {
    const size = spacing * shell.settings.overlap * sizeScale;
    shell.centers.push(center.clone());
    // Local +Z is the disc's thin axis, so rotating +Z onto the normal leaves the
    // two fat axes lying in the tangent plane.
    shell.quats.push(new THREE.Quaternion().setFromUnitVectors(Z, normal));
    shell.scales.push(new THREE.Vector3(size, size, size * FLATNESS));
    shell.colors.push(color.clone());
    shell.owners.push(owner);
}

/**
 * How far a disc visibly reaches, in multiples of its scale. A Gaussian has no edge,
 * but past about this it's faint enough not to read as colour.
 */
const DISC_REACH = 2.2;
const edgeBasis = new THREE.Matrix4();
const edgeU = new THREE.Vector3();
const edgeV = new THREE.Vector3();

/**
 * A disc beside a colour edge or a cut: unjittered, and squashed ACROSS the edge so
 * its reach stops at the line instead of spilling over it. `across` is the direction
 * pointing across the edge; `distance` is how far the disc's centre is from it.
 *
 * Without this, a boundary is decided per splat centre and every disc pokes past it
 * by its own radius — which reads as a ragged, spiky edge once splats get big.
 */
function addEdgeDisc(
    shell: Shell,
    center: THREE.Vector3,
    normal: THREE.Vector3,
    across: THREE.Vector3,
    distance: number,
    spacing: number,
    color: THREE.Color,
    owner: number,
): void {
    const size = spacing * shell.settings.overlap;
    // Tangent frame: v across the edge, u along it, normal through the disc.
    edgeU.copy(across).cross(normal).normalize();
    edgeV.copy(normal).cross(edgeU).normalize();
    edgeBasis.makeBasis(edgeU, edgeV, normal);
    const squash = THREE.MathUtils.clamp(distance / (DISC_REACH * size), 0.25, 1);
    shell.centers.push(center.clone());
    shell.quats.push(new THREE.Quaternion().setFromRotationMatrix(edgeBasis));
    shell.scales.push(new THREE.Vector3(size, size * squash, size * FLATNESS));
    shell.colors.push(color.clone());
    shell.owners.push(owner);
}

export type SphereOptions = {
    /** Keep only points whose unit-sphere y is above this, for caps like hair. */
    minY?: number;
    /** Keep only points whose unit-sphere z is above this, for faces. */
    minZ?: number;
    /**
     * Arbitrary filter on the unit-sphere point, for shapes a single threshold
     * can't express — a bowl cut, say, which has to stop above the brows at the
     * front while coming down past the ears at the back.
     */
    keep?: (unit: THREE.Vector3) => boolean;
    /**
     * Scale the x/z radii by height. An ellipsoid is symmetric top to bottom, so it
     * gives a tall head but never a CHIN; squeezing the cross-section does.
     */
    taper?: (unitY: number) => number;
    /** Squash the sphere into an ellipsoid. */
    radii?: THREE.Vector3;
    /** Rotate the ellipsoid before placing it. */
    quat?: THREE.Quaternion;
    /**
     * How many shells to stack, each tucked just inside the last.
     *
     * One layer of small discs is see-THROUGH: a Gaussian has no edge, so between
     * four neighbouring centres the accumulated alpha dips and the background shows.
     * Shrinking discs for sharpness widens those dips.
     *
     * The fix is depth, not width. An inner shell plugs the gaps while staying hidden
     * behind the outer one at the silhouette, so the outline stays crisp. Real
     * captures are opaque for the same reason — many layers deep, not one crust.
     */
    layers?: number;
};

/**
 * A sphere or ellipsoid shell, sampled with the Fibonacci lattice — even spacing
 * everywhere, with none of the bunching at the poles that a lat/long grid gives.
 */
export function addSphere(
    shell: Shell,
    center: THREE.Vector3,
    radius: number,
    spacing: number,
    color: THREE.Color,
    owner: number,
    options: SphereOptions = {},
): void {
    const baseRadii = options.radii ?? new THREE.Vector3(radius, radius, radius);
    const layers = options.layers ?? 1;
    const inset = spacing * shell.settings.overlap;

    const radii = new THREE.Vector3();
    const unit = new THREE.Vector3();
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let layer = 0; layer < layers; layer++) {
        // Rotated so each shell's discs land in the previous layer's gaps rather
        // than directly behind its discs, where they'd do nothing.
        radii.set(
            Math.max(1e-4, baseRadii.x - layer * inset),
            Math.max(1e-4, baseRadii.y - layer * inset),
            Math.max(1e-4, baseRadii.z - layer * inset),
        );
        // From the radii actually being covered, not nominal `radius`: the hair passes
        // a small radius with large `radii`, and would otherwise come out gappy.
        const mean = (radii.x + radii.y + radii.z) / 3;
        const area = 4 * Math.PI * mean * mean;
        const count = Math.max(24, Math.round(area / (spacing * spacing)));
        const phase = layer * 0.5;

        for (let i = 0; i < count; i++) {
            const y = 1 - (i / (count - 1)) * 2;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = (i + phase) * GOLDEN_ANGLE;
            unit.set(Math.cos(theta) * r, y, Math.sin(theta) * r);

            if (options.minY !== undefined && unit.y < options.minY) continue;
            if (options.minZ !== undefined && unit.z < options.minZ) continue;
            if (options.keep && !options.keep(unit)) continue;

            const k = options.taper ? options.taper(unit.y) : 1;
            const rx = radii.x * k;
            const rz = radii.z * k;
            point.set(unit.x * rx, unit.y * radii.y, unit.z * rz);
            // The ellipsoid normal is the gradient, p / radii², not the position.
            // Approximate under a taper, but these splats are unlit, so a slight tilt
            // in which way a disc faces is invisible.
            normal.set(point.x / (rx * rx), point.y / (radii.y * radii.y), point.z / (rz * rz)).normalize();

            if (options.quat) {
                point.applyQuaternion(options.quat);
                normal.applyQuaternion(options.quat);
            }
            point.add(center);
            jitter(shell, point, normal, spacing);
            addDisc(shell, point, normal, spacing, color, owner);
        }
    }
}

/**
 * A flat filled disc, sunflower-sampled for even area coverage. How you get a
 * straight cut edge out of splats instead of the dome a rounded cap leaves.
 */
export function addFlatCap(
    shell: Shell,
    center: THREE.Vector3,
    normal: THREE.Vector3,
    radius: number,
    spacing: number,
    color: THREE.Color,
    owner: number,
    /**
     * Leave a hole, turning the disc into a ring — for a cut edge over something
     * else, like a sleeve over an arm. Splats sort rather than depth-test, so
     * coincident splats of different colours swap order and flicker.
     */
    innerRadius = 0,
): void {
    const side = (Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).cross(normal).normalize();
    const other = normal.clone().cross(side).normalize();
    const radial = new THREE.Vector3();

    // A ring narrower than a couple of discs (a cuff): one circle down its middle,
    // each disc squashed to fit the ring's width. Scattered over the area instead, a
    // disc bigger than the ring is wide pokes out both sides and the cut looks frayed.
    const width = radius - innerRadius;
    if (innerRadius > 0 && width < 2 * spacing) {
        const mid = innerRadius + width / 2;
        const around = Math.max(8, Math.ceil((2 * Math.PI * mid) / (spacing * 0.7)));
        const point = new THREE.Vector3();
        for (let i = 0; i < around; i++) {
            const theta = (i / around) * Math.PI * 2;
            radial.copy(side).multiplyScalar(Math.cos(theta)).addScaledVector(other, Math.sin(theta));
            point.copy(center).addScaledVector(radial, mid);
            addEdgeDisc(shell, point, normal, radial, width / 2, spacing, color, owner);
        }
        return;
    }

    const area = Math.PI * (radius * radius - innerRadius * innerRadius);
    const count = Math.max(8, Math.round(area / (spacing * spacing)));
    const point = new THREE.Vector3();
    const innerSq = innerRadius * innerRadius;
    const span = radius * radius - innerSq;

    for (let i = 0; i < count; i++) {
        const r = Math.sqrt(innerSq + span * ((i + 0.5) / count));
        const theta = i * GOLDEN_ANGLE;
        point
            .copy(center)
            .addScaledVector(side, Math.cos(theta) * r)
            .addScaledVector(other, Math.sin(theta) * r);
        // Near the rim, keep the disc inside it.
        if (radius - r < spacing) {
            radial.copy(point).sub(center).normalize();
            addEdgeDisc(shell, point, normal, radial, radius - r, spacing, color, owner);
            continue;
        }
        jitter(shell, point, normal, spacing);
        addDisc(shell, point, normal, spacing, color, owner);
    }
}

/**
 * A tapered capsule shell: a cone-ish side wall plus a rounded cap at each end.
 * Limbs and sleeves. The torso is a loft instead — see addLoft for why a stack
 * of these was the wrong tool for it.
 */
export type CapMode = 'round' | 'flat' | 'none';

export type CapsuleOptions = {
    capA?: CapMode;
    capB?: CapMode;
    /** Hole radius for a 'flat' cap, making it a ring — see addFlatCap. */
    innerA?: number;
    innerB?: number;
    /** See SphereOptions.layers — the cure for a see-through surface. */
    layers?: number;
    /** A clean cut at that end: rings stop half a step short and don't spill past it. */
    crispA?: boolean;
    crispB?: boolean;
};

export function addCapsule(
    shell: Shell,
    a: THREE.Vector3,
    b: THREE.Vector3,
    radiusA: number,
    radiusB: number,
    spacing: number,
    color: THREE.Color,
    owner: number,
    options: CapsuleOptions = {},
): void {
    const layers = options.layers ?? 1;
    const inset = spacing * shell.settings.overlap;
    const axis = b.clone().sub(a);
    const length = axis.length();
    axis.normalize();

    // A frame perpendicular to the axis, however the axis happens to point.
    const seed = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const side = seed.clone().cross(axis).normalize();
    const other = axis.clone().cross(side).normalize();

    const rings = Math.max(2, Math.round(length / spacing));
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    // The side wall of a tapered capsule leans, so its normal tilts along the axis
    // by the taper angle rather than sitting perpendicular to it.
    const lean = (radiusA - radiusB) / length;

    for (let layer = 0; layer < layers; layer++) {
        const rA = Math.max(1e-4, radiusA - layer * inset);
        const rB = Math.max(1e-4, radiusB - layer * inset);
        // A crisp end puts its last ring half a step in, so the cut falls between
        // rings rather than through one.
        const first = options.crispA ? 0.5 : 0;
        const last = options.crispB ? rings - 0.5 : rings;
        for (let i = first; i <= last + 1e-6; i++) {
            const t = i / rings;
            const radius = THREE.MathUtils.lerp(rA, rB, t);
            const toA = options.crispA ? t * length : Number.POSITIVE_INFINITY;
            const toB = options.crispB ? (1 - t) * length : Number.POSITIVE_INFINITY;
            const toEnd = Math.min(toA, toB);
            const around = Math.max(6, Math.round((2 * Math.PI * radius) / spacing));
            for (let j = 0; j < around; j++) {
                // Stagger alternate rings, and each layer again, so nothing lines up
                // into a visible lattice.
                const ang = ((j + (Math.floor(i) % 2) * 0.5 + layer * 0.37) / around) * Math.PI * 2;
                const cos = Math.cos(ang);
                const sin = Math.sin(ang);
                point
                    .copy(a)
                    .addScaledVector(axis, t * length)
                    .addScaledVector(side, cos * radius)
                    .addScaledVector(other, sin * radius);
                normal
                    .set(0, 0, 0)
                    .addScaledVector(side, cos)
                    .addScaledVector(other, sin)
                    .addScaledVector(axis, lean)
                    .normalize();
                if (toEnd < spacing) {
                    addEdgeDisc(shell, point, normal, axis, toEnd, spacing, color, owner);
                    continue;
                }
                jitter(shell, point, normal, spacing);
                addDisc(shell, point, normal, spacing, color, owner);
            }
        }
    }

    const capA = options.capA ?? 'round';
    const capB = options.capB ?? 'round';
    const down = axis.clone().negate();

    if (capA === 'round') {
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), down);
        addSphere(shell, a, radiusA, spacing, color, owner, { minY: 0.05, quat, layers });
    } else if (capA === 'flat') {
        addFlatCap(shell, a, down, radiusA, spacing, color, owner, options.innerA ?? 0);
    }

    if (capB === 'round') {
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        addSphere(shell, b, radiusB, spacing, color, owner, { minY: 0.05, quat, layers });
    } else if (capB === 'flat') {
        addFlatCap(shell, b, axis, radiusB, spacing, color, owner, options.innerB ?? 0);
    }
}

/**
 * A flat DECAL laid onto a curved surface — the right primitive for a face.
 *
 * A face's features are flat vector shapes: an eye has a flatter top than bottom, a
 * brow is a rounded bar, a mouth is a slot. None is an ellipse, so an ellipsoid of
 * splats can't draw any of them.
 *
 * Instead: sample a 2D lattice in the feature's own plane, keep what the outline says
 * is inside, project onto the sphere. The shape becomes a predicate over [-1, 1],
 * and the projection keeps it on the curve of the face rather than floating in front.
 */
export function addDecal(
    shell: Shell,
    opts: {
        /** Centre of the sphere the decal wraps onto, and how far out it sits. */
        centre: THREE.Vector3;
        dir: THREE.Vector3;
        radius: number;
        halfWidth: number;
        halfHeight: number;
        /** Rotation within the decal's own plane, in radians. */
        roll?: number;
        /**
         * Multiplier on `radius` along each direction from `centre`, so the decal can
         * wrap a surface that isn't a sphere. Without it, on an ellipsoid head the
         * features float off the face at some angles and sink under it at others.
         */
        surface?: (dir: THREE.Vector3) => number;
        inside: (u: number, v: number) => boolean;
        spacing: number;
        color: THREE.Color;
        owner: number;
        /** See addDisc's sizeScale — decals are flat, so they need fatter discs. */
        sizeScale?: number;
    },
): void {
    const { centre, dir, radius, halfWidth, halfHeight, inside, spacing, color, owner } = opts;
    const roll = opts.roll ?? 0;

    const forward = dir.clone().normalize();
    const seed = Math.abs(forward.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = seed.clone().cross(forward).normalize();
    const up = forward.clone().cross(right).normalize();

    const cos = Math.cos(roll);
    const sin = Math.sin(roll);

    const nu = Math.max(2, Math.ceil((2 * halfWidth) / spacing));
    const nv = Math.max(2, Math.ceil((2 * halfHeight) / spacing));
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let iv = 0; iv <= nv; iv++) {
        const v = (iv / nv) * 2 - 1;
        for (let iu = 0; iu <= nu; iu++) {
            // Stagger alternate rows: a square grid leaves diamond gaps, hex doesn't.
            const u = ((iu + (iv % 2) * 0.5) / nu) * 2 - 1;
            if (!inside(u, v)) continue;

            const du = u * cos - v * sin;
            const dv = u * sin + v * cos;
            point
                .copy(forward)
                .multiplyScalar(radius)
                .addScaledVector(right, du * halfWidth)
                .addScaledVector(up, dv * halfHeight);
            // Push back out to the sphere so the decal follows the face's curve.
            normal.copy(point).normalize();
            point
                .copy(normal)
                .multiplyScalar(radius * (opts.surface ? opts.surface(normal) : 1))
                .add(centre);
            jitter(shell, point, normal, spacing);
            addDisc(shell, point, normal, spacing, color, owner, opts.sizeScale ?? 1);
        }
    }
}

/**
 * Outlines for `addDecal`, as superellipses: |u|^n + |v|^n <= 1.
 *
 * n = 2 is an ellipse, n = 4 is nearly a rounded rectangle. Between the two is
 * where most character features live, because they want a flat-ish run with
 * rounded corners rather than continuous curvature.
 */
export const superellipse = (n: number) => (u: number, v: number) => Math.abs(u) ** n + Math.abs(v) ** n <= 1;

/**
 * An eye outline: flatter across the top, rounder underneath. The asymmetry is the
 * point — a symmetric oval reads as a bead, the flat top reads as a lid.
 */
export const lidShape = (top: number, bottom: number) => (u: number, v: number) => {
    const n = v > 0 ? top : bottom;
    return Math.abs(u) ** n + Math.abs(v) ** n <= 1;
};

/**
 * A LOFT: one continuous surface swept along an authored silhouette.
 *
 * Replaces stacking capsules for the torso, structurally rather than cosmetically.
 * Every join between two primitives is two closed surfaces interpenetrating, each
 * needing individual defusing — a cap left on the chest stands a hemisphere of shirt
 * inside the skull, one on the waist hangs a dome for the legs to poke through, and
 * neither is visible head-on. A loft has no joins.
 *
 * The silhouette becomes the thing you author directly, instead of hoping a stack of
 * capsules adds up to one. The cross-section is a superellipse, since a torso is
 * wider than it is deep and squarer than an ellipse across the chest.
 */
export type LoftPoint = {
    y: number;
    /** Half-width at this height. */
    width: number;
    /** Half-depth, front to back. Defaults to a flattened fraction of the width. */
    depth?: number;
};

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Sample the profile at height `y`, smoothly through the control points. */
function sampleProfile(profile: LoftPoint[], y: number, key: 'width' | 'depth'): number {
    const get = (i: number) => {
        const p = profile[Math.max(0, Math.min(profile.length - 1, i))];
        return key === 'depth' ? (p.depth ?? p.width * 0.72) : p.width;
    };
    if (y <= profile[0].y) return get(0);
    if (y >= profile[profile.length - 1].y) return get(profile.length - 1);
    let i = 0;
    while (i < profile.length - 2 && y > profile[i + 1].y) i++;
    const span = profile[i + 1].y - profile[i].y;
    const t = span > 1e-6 ? (y - profile[i].y) / span : 0;
    return catmullRom(get(i - 1), get(i), get(i + 1), get(i + 2), t);
}

const ARC_SAMPLES = 256;
const arcX = new Float64Array(ARC_SAMPLES + 1);
const arcZ = new Float64Array(ARC_SAMPLES + 1);
const arcLen = new Float64Array(ARC_SAMPLES + 1);

export function addLoft(
    shell: Shell,
    opts: {
        profile: LoftPoint[];
        /** Superellipse exponent for the cross-section. 2 = ellipse, 4 = rounded box. */
        roundness: number;
        spacing: number;
        /**
         * Colour at a given height. A function, so a garment boundary is a colour
         * change ON one surface rather than two surfaces meeting — as crisp as a
         * single splat, and it cannot interpenetrate anything.
         */
        colorAt: (y: number) => THREE.Color;
        /** Which bone owns a splat at this height — a torso spans two. */
        ownerAt: (y: number) => number;
        layers?: number;
        /** Close the bottom with a flat disc (a hem); the top is left open. */
        capBottom?: boolean;
        /**
         * Heights where `colorAt` changes. Rings straddle each one half a step either
         * side, unjittered and squashed, so the colour change is a clean line.
         */
        edges?: number[];
    },
): void {
    const { profile, roundness, spacing, colorAt, ownerAt } = opts;
    const layers = opts.layers ?? 1;
    const inset = spacing * shell.settings.overlap;

    const y0 = profile[0].y;
    const y1 = profile[profile.length - 1].y;
    const rings = Math.max(2, Math.ceil((y1 - y0) / spacing));

    // Ring heights. With no edges, evenly from end to end; with edges, each segment
    // between them gets its own even run, stopping half a step short of an edge.
    const edges = (opts.edges ?? []).filter((e) => e > y0 && e < y1).sort((a, b) => a - b);
    const heights: number[] = [];
    if (edges.length === 0) {
        for (let i = 0; i <= rings; i++) heights.push(y0 + ((y1 - y0) * i) / rings);
    } else {
        const stops = [y0, ...edges, y1];
        for (let k = 0; k < stops.length - 1; k++) {
            const a = stops[k];
            const b = stops[k + 1];
            const n = Math.max(1, Math.round((b - a) / spacing));
            const step = (b - a) / n;
            const start = k > 0 ? a + step / 2 : a;
            const end = k < stops.length - 2 ? b - step / 2 : b;
            const count = Math.max(0, Math.round((end - start) / step));
            for (let i = 0; i <= count; i++) heights.push(count ? start + ((end - start) * i) / count : (start + end) / 2);
        }
    }
    const up = new THREE.Vector3(0, 1, 0);

    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let layer = 0; layer < layers; layer++) {
        for (let i = 0; i < heights.length; i++) {
            const y = heights[i];
            let toEdge = Number.POSITIVE_INFINITY;
            for (const e of edges) toEdge = Math.min(toEdge, Math.abs(y - e));
            const w = Math.max(1e-4, sampleProfile(profile, y, 'width') - layer * inset);
            const d = Math.max(1e-4, sampleProfile(profile, y, 'depth') - layer * inset);
            // Local slope of the silhouette, so the surface normal tilts with it
            // instead of pointing flatly outward on a cone.
            const h = Math.max(1e-4, (y1 - y0) / rings);
            const slope = (sampleProfile(profile, y + h, 'width') - sampleProfile(profile, y - h, 'width')) / (2 * h);

            // Walk the cross-section at even ARC LENGTH. Stepping the angle uniformly
            // doesn't step the outline uniformly — on a superellipse the point races
            // through the flat runs and crawls round the corners, which bunches splats
            // there and reads as a seam down the middle of the chest.
            const e = 2 / roundness;
            // Buffers are reused: the outline changes with height, but a torso is a
            // couple of hundred rings deep and needn't reallocate for each.
            arcX[0] = w;
            arcZ[0] = 0;
            arcLen[0] = 0;
            for (let k = 1; k <= ARC_SAMPLES; k++) {
                const a = (k / ARC_SAMPLES) * Math.PI * 2;
                const ca = Math.cos(a);
                const sa = Math.sin(a);
                arcX[k] = w * Math.sign(ca) * Math.abs(ca) ** e;
                arcZ[k] = d * Math.sign(sa) * Math.abs(sa) ** e;
                arcLen[k] = arcLen[k - 1] + Math.hypot(arcX[k] - arcX[k - 1], arcZ[k] - arcZ[k - 1]);
            }
            const perimeter = arcLen[ARC_SAMPLES];
            const steps = Math.max(12, Math.round(perimeter / spacing));
            for (let j = 0; j < steps; j++) {
                const target = (((j + (i % 2) * 0.5 + layer * 0.37) % steps) / steps) * perimeter;
                let cursor = 0;
                while (cursor < ARC_SAMPLES - 1 && arcLen[cursor + 1] < target) cursor++;
                const seg = Math.max(1e-9, arcLen[cursor + 1] - arcLen[cursor]);
                const f = (target - arcLen[cursor]) / seg;
                const px = arcX[cursor] + (arcX[cursor + 1] - arcX[cursor]) * f;
                const pz = arcZ[cursor] + (arcZ[cursor + 1] - arcZ[cursor]) * f;
                point.set(px, y, pz);
                // Superellipse gradient, then tilted by the profile slope.
                const gx = w > 1e-6 ? (Math.sign(px) * Math.abs(px / w) ** (roundness - 1)) / w : 0;
                const gz = d > 1e-6 ? (Math.sign(pz) * Math.abs(pz / d) ** (roundness - 1)) / d : 0;
                normal.set(gx, 0, gz).normalize();
                normal.y = -slope;
                normal.normalize();
                if (toEdge < spacing) {
                    addEdgeDisc(shell, point, normal, up, toEdge, spacing, colorAt(y), ownerAt(y));
                    continue;
                }
                jitter(shell, point, normal, spacing);
                addDisc(shell, point, normal, spacing, colorAt(y), ownerAt(y));
            }
        }
    }

    if (opts.capBottom) {
        const w = sampleProfile(profile, y0, 'width');
        const d = sampleProfile(profile, y0, 'depth');
        const n = Math.max(8, Math.round((Math.PI * w * d) / (spacing * spacing)));
        const down = new THREE.Vector3(0, -1, 0);
        for (let k = 0; k < n; k++) {
            const r = Math.sqrt((k + 0.5) / n);
            const a = k * GOLDEN_ANGLE;
            point.set(Math.cos(a) * r * w, y0, Math.sin(a) * r * d);
            addDisc(shell, point, down, spacing, colorAt(y0), ownerAt(y0));
        }
    }
}
