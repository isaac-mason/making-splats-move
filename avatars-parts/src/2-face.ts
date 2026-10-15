import { type Vec2, type Vec3, vec2, vec3 } from 'math';
import { disc, type RGB, rgb, sphere, splat } from './1-shapes';
import type { SplatBuilder } from './splats';

export const SKIN = rgb(0xffd3ae);
const INK = rgb(0x2a2024);
const WHITE = rgb(0xffffff);
const BLUSH = rgb(0xffa6a6);
const NOSE = rgb(0xe8b48f);
const FINE = 0.004;

const _normal = vec3.create();
const _at = vec3.create();
const _size: Vec2 = [0, 0];

/** A face on the head at `head`: flat discs, each stacked a little further out than the last. */
export function face(mesh: SplatBuilder, head: Vec3, r: number) {
    // A spot on the face, `x` across and `y` up, floated `layer` steps off the skin.
    const on = (x: number, y: number, layer: number) => {
        vec3.normalize(_normal, vec3.set(_normal, x, y, 1));
        vec3.scaleAndAdd(_at, head, _normal, r * (1.04 + layer * 0.02));
    };
    const feature = (x: number, y: number, layer: number, w: number, h: number, color: RGB) => {
        on(x, y, layer);
        disc(mesh, _at, _normal, vec2.set(_size, w * r, h * r), color, FINE);
    };

    for (const side of [-1, 1]) {
        const eye = side * 0.27;
        feature(eye, -0.13, 0, 0.14, 0.18, INK);
        feature(eye, -0.13, 1, 0.115, 0.155, WHITE);
        feature(eye, -0.14, 2, 0.08, 0.105, INK);
        feature(eye - 0.03, -0.1, 3, 0.03, 0.03, WHITE);
        feature(eye + 0.025, -0.18, 3, 0.015, 0.015, WHITE);
        feature(eye, 0.15, 0, 0.12, 0.018, INK);
        feature(side * 0.44, -0.32, 0, 0.11, 0.07, BLUSH);
    }
    feature(0, -0.2, 0, 0.035, 0.035, NOSE);

    // The smile: a row of small splats along a curve.
    for (let t = -1; t <= 1; t += 0.05) {
        on(t * 0.1, -0.4 + 0.04 * t * t, 0);
        splat(mesh, _at, _normal, INK, FINE * 1.2);
    }
}

export function faceDemo(mesh: SplatBuilder) {
    const head: Vec3 = [0, 1, 0];
    sphere(mesh, head, [0.35, 0.34, 0.33], SKIN);
    face(mesh, head, 0.34);
}
