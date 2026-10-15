import type { Vec3 } from 'math';
import { capsule, rgb, sphere } from './1-shapes';
import { face, SKIN } from './2-face';
import type { SplatBuilder } from './splats';

const HAIR = rgb(0x1a1414);
const SHIRT = rgb(0xd31e15);
const TROUSERS = rgb(0x3f4148);
const SHOES = rgb(0x2a2a2e);

const R = 0.34;
export const HEAD: Vec3 = [0, 1.25, 0];
export const SHOULDER: Vec3 = [0.18, 0.79, 0];
export const ELBOW: Vec3 = [0.31, 0.71, 0];
export const HAND: Vec3 = [0.365, 0.546, 0];
export const HIP: Vec3 = [0.1, 0.43, 0];
export const ANKLE: Vec3 = [0.1, 0.08, 0];

export const mirror = ([x, y, z]: Vec3, side: number): Vec3 => [x * side, y, z];

function underHair(u: Vec3) {
    const front = Math.max(0, u[2]) ** 2;
    const across = Math.atan2(u[0], Math.max(u[2], 1e-4)) * 2.2 + 0.7;
    const tooth = 1 - 2 * Math.abs(across - Math.floor(across) - 0.5);
    return u[1] > -0.5 + front * (1.08 - 0.15 * tooth);
}

export function head(mesh: SplatBuilder) {
    sphere(mesh, HEAD, [R * 1.03, R * 0.98, R * 0.96], SKIN);
    face(mesh, HEAD, R);
    sphere(mesh, HEAD, [R * 1.12, R * 1.07, R * 1.05], HAIR, { keep: underHair });
}

export function torso(mesh: SplatBuilder) {
    sphere(mesh, [0, 0.64, 0], [0.152, 0.232, 0.102], TROUSERS, { keep: (u) => u[1] < -0.2, roundness: 3 });
    sphere(mesh, [0, 0.64, 0], [0.16, 0.24, 0.11], SHIRT, { keep: (u) => u[1] > -0.38, roundness: 3 });
    sphere(mesh, [0, 0.87, 0], [0.13, 0.08, 0.09], SHIRT);
}

export function upperArm(mesh: SplatBuilder, side: number) {
    capsule(mesh, mirror(SHOULDER, side), mirror(ELBOW, side), 0.06, SKIN);
    capsule(mesh, mirror(SHOULDER, side), mirror([0.235, 0.758, 0], side), 0.08, SHIRT);
}

export function forearm(mesh: SplatBuilder, side: number) {
    capsule(mesh, mirror(ELBOW, side), mirror(HAND, side), 0.056, SKIN);
    sphere(mesh, mirror(HAND, side), [0.085, 0.085, 0.085], SKIN);
}

export function arm(mesh: SplatBuilder, side: number) {
    upperArm(mesh, side);
    forearm(mesh, side);
}

export function leg(mesh: SplatBuilder, side: number) {
    capsule(mesh, mirror(HIP, side), mirror(ANKLE, side), 0.072, TROUSERS);
    sphere(mesh, mirror([HIP[0], 0.045, 0.035], side), [0.075, 0.05, 0.125], SHOES);
}

export function body(mesh: SplatBuilder) {
    head(mesh);
    torso(mesh);
    for (const side of [-1, 1]) {
        arm(mesh, side);
        leg(mesh, side);
    }
}
