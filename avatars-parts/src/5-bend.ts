import type { SplatMesh } from '@sparkjsdev/spark';
import { clamp, type Vec3, type Vec4, vec4 } from 'math';
import { capsule, rgb, sphere } from './1-shapes';
import { animate, type Bone } from './4-skinning';

const STEM = rgb(0x5a9e3a);
const PETAL = rgb(0xff9ec7);
const MIDDLE = rgb(0xffd23f);

const LINKS = 4;
const LINK = 0.22;
const BASE = 0.1;
const TOP = BASE + LINK * LINKS;

/** A chain of bones up the stem, each turning a little after the one below. */
const BONES: Bone[] = Array.from({ length: LINKS }, (_, k) => ({
    joint: [0, BASE + k * LINK, 0],
    tip: [0, BASE + (k + 1) * LINK, 0],
    axis: [0, 0, 1],
    angle: (t) => Math.sin(t * 2.5 - k * 0.7) * 0.2,
    parent: k === 0 ? undefined : k - 1,
}));
BONES[0].build = flower;
BONES[0].weights = alongStem;

function flower(mesh: SplatMesh) {
    capsule(mesh, [0, BASE, 0], [0, TOP - 0.06, 0], 0.022, STEM);
    sphere(mesh, [-0.07, 0.42, 0], [0.07, 0.022, 0.02], STEM);
    sphere(mesh, [0.07, 0.62, 0], [0.07, 0.022, 0.02], STEM);
    for (let p = 0; p < 6; p++) {
        const angle = (p / 6) * Math.PI * 2;
        sphere(mesh, [Math.cos(angle) * 0.075, TOP + Math.sin(angle) * 0.075, 0.03], [0.05, 0.05, 0.02], PETAL);
    }
    sphere(mesh, [0, TOP, 0.055], [0.045, 0.045, 0.02], MIDDLE);
}

/** Each splat shared between the two links nearest it, by height: that's what makes it bend, not hinge. */
function alongStem([, y]: Vec3, bones: Vec4, amounts: Vec4) {
    const along = clamp((y - BASE) / LINK - 0.5, 0, LINKS - 1);
    const k = Math.min(Math.floor(along), LINKS - 2);
    vec4.set(bones, k, k + 1, 0, 0);
    vec4.set(amounts, 1 - (along - k), along - k, 0, 0);
}

export const bend = (mesh: SplatMesh) => animate(mesh, BONES);
