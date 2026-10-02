import { SplatMesh } from '@sparkjsdev/spark';
import { quat, type Vec2, type Vec3, vec3 } from 'math';
import * as THREE from 'three';

export type RGB = [number, number, number];

const SPACING = 0.01;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];
const FACING = Z;
/** A splat's thickness, as a fraction of its width: flat, like a disc. */
const FLATNESS = 0.15;
/** Past fully opaque: harder-edged discs, so seams and silhouettes stay crisp. */
const HARDNESS = 2;
/** Splats smaller than this stay soft: hard ones that small go blobby. */
const SOFT_BELOW = SPACING / 2;

/** A colour as Spark wants it: sRGB, 0..1. */
export const rgb = (hex: number): RGB => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/** A SplatMesh that takes opacity above 1. Spark stores it halved, so splats pass HARDNESS / 2. */
export function createMesh() {
    const mesh = new SplatMesh({});
    if (mesh.packedSplats) mesh.packedSplats.splatEncoding = { ...mesh.packedSplats.splatEncoding, lodOpacity: true };
    return mesh;
}

// Spark takes three.js types: each splat passes through these on its way in.
const _center = new THREE.Vector3();
const _scales = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _tint = new THREE.Color();
const _facing = quat.create();

/**
 * One splat: a small flat Gaussian disc, lying across `normal`. `hardness` over 1 is
 * past fully opaque, for a crisper edge; tiny splats default to soft.
 */
export function splat(
    mesh: SplatMesh,
    at: Vec3,
    normal: Vec3,
    color: RGB,
    size = SPACING,
    hardness = size < SOFT_BELOW ? 1 : HARDNESS,
) {
    quat.rotationTo(_facing, FACING, normal);
    mesh.pushSplat(
        _center.fromArray(at),
        _scales.set(size, size, size * FLATNESS),
        _rotation.fromArray(_facing),
        hardness / 2,
        _tint.setRGB(color[0], color[1], color[2]),
    );
}

/** The `i`th of `count` directions spread evenly round a sphere, on a Fibonacci spiral. */
function spiral(out: Vec3, i: number, count: number): Vec3 {
    const y = 1 - (2 * i) / (count - 1);
    const ring = Math.sqrt(1 - y * y);
    return vec3.set(out, Math.cos(i * GOLDEN_ANGLE) * ring, y, Math.sin(i * GOLDEN_ANGLE) * ring);
}

/** Where `unit` meets the surface |x/a|ⁿ + |y/b|ⁿ + |z/c|ⁿ = 1, into `point`, and the normal there. */
function superellipsoid(point: Vec3, normal: Vec3, unit: Vec3, radii: Vec3, n: number) {
    const scale = (Math.abs(unit[0]) ** n + Math.abs(unit[1]) ** n + Math.abs(unit[2]) ** n) ** (-1 / n);
    vec3.scale(point, vec3.multiply(point, unit, radii), scale);
    for (let k = 0; k < 3; k++) normal[k] = (Math.sign(point[k]) * Math.abs(point[k] / radii[k]) ** (n - 1)) / radii[k];
    vec3.normalize(normal, normal);
}

type SphereOptions = {
    /** Which directions from the centre to cover, for cut shapes like hair. */
    keep?: (unit: Vec3) => boolean;
    /** 2 is an ellipsoid; higher squares it off towards a box. */
    roundness?: number;
};

const NEIGHBOURS: Vec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];

const _unit = vec3.create();
const _nearby = vec3.create();
const _point = vec3.create();
const _normal = vec3.create();

/** A shell of splats over an ellipsoid. */
export function sphere(
    mesh: SplatMesh,
    middle: Vec3,
    radii: Vec3,
    color: RGB,
    { keep = () => true, roundness = 2 }: SphereOptions = {},
) {
    const mean = (radii[0] + radii[1] + radii[2]) / 3;
    const count = Math.round((4 * Math.PI * mean ** 2) / SPACING ** 2);
    const reach = (1.5 * SPACING) / mean;
    const cutToward = (step: Vec3) => !keep(vec3.normalize(_nearby, vec3.scaleAndAdd(_nearby, _unit, step, reach)));
    for (let i = 0; i < count; i++) {
        spiral(_unit, i, count);
        if (!keep(_unit)) continue;
        // Beside a cut, a full-size splat spills across the line; a smaller one stops at it.
        const nearCut = NEIGHBOURS.some(cutToward);
        superellipsoid(_point, _normal, _unit, radii, roundness);
        splat(mesh, vec3.add(_point, _point, middle), _normal, color, nearCut ? SPACING / 2 : SPACING);
    }
}

const _axis = vec3.create();
const _side = vec3.create();
const _other = vec3.create();
const _around = vec3.create();
const _onTube = vec3.create();
const _capRadii = vec3.create();

/** A tube from `a` to `b`, closed with half-spheres: arms and legs. */
export function capsule(mesh: SplatMesh, a: Vec3, b: Vec3, radius: number, color: RGB) {
    const length = vec3.length(vec3.sub(_axis, b, a));
    vec3.normalize(_axis, _axis);
    vec3.normalize(_side, vec3.cross(_side, _axis, Math.abs(_axis[2]) < 0.9 ? Z : X));
    vec3.cross(_other, _axis, _side);
    const ring = Math.round((2 * Math.PI * radius) / SPACING);
    for (let i = 0; i <= Math.round(length / SPACING); i++) {
        for (let j = 0; j < ring; j++) {
            const angle = ((j + (i % 2) * 0.5) / ring) * 2 * Math.PI;
            vec3.scaleAndAdd(_around, vec3.scale(_around, _side, Math.cos(angle)), _other, Math.sin(angle));
            vec3.scaleAndAdd(_onTube, a, _axis, i * SPACING);
            splat(mesh, vec3.scaleAndAdd(_onTube, _onTube, _around, radius), _around, color);
        }
    }
    vec3.set(_capRadii, radius, radius, radius);
    sphere(mesh, a, _capRadii, color, { keep: (u) => vec3.dot(u, _axis) < 0 });
    sphere(mesh, b, _capRadii, color, { keep: (u) => vec3.dot(u, _axis) > 0 });
}

const _right = vec3.create();
const _up = vec3.create();
const _onDisc = vec3.create();

/** A flat, filled ellipse facing `normal`, spread as a sunflower so it has no rows. */
export function disc(mesh: SplatMesh, middle: Vec3, normal: Vec3, size: Vec2, color: RGB, spacing = SPACING) {
    vec3.normalize(_right, vec3.cross(_right, Y, normal));
    vec3.cross(_up, normal, _right);
    const count = Math.max(1, Math.round((Math.PI * size[0] * size[1]) / spacing ** 2));
    for (let i = 0; i < count; i++) {
        const r = Math.sqrt((i + 0.5) / count);
        vec3.scaleAndAdd(_onDisc, middle, _right, Math.cos(i * GOLDEN_ANGLE) * r * size[0]);
        vec3.scaleAndAdd(_onDisc, _onDisc, _up, Math.sin(i * GOLDEN_ANGLE) * r * size[1]);
        splat(mesh, _onDisc, normal, color, spacing);
    }
}

export function shapes(mesh: SplatMesh) {
    splat(mesh, [-1.0, 1, 0], Z, rgb(0x3b3346), 0.06, 1);
    sphere(mesh, [-0.55, 1, 0], [0.22, 0.22, 0.22], rgb(0xffd3ae));
    sphere(mesh, [-0.05, 1, 0], [0.18, 0.22, 0.12], rgb(0xd31e15), { roundness: 3 });
    capsule(mesh, [0.3, 0.8, 0], [0.45, 1.2, 0], 0.07, rgb(0x3f4148));
    disc(mesh, [0.85, 1, 0], Z, [0.18, 0.13], rgb(0x0a49b3));
}
