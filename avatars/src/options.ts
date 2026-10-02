import * as THREE from 'three';

import { EXPRESSIONS, type Expression } from './avatar';

/**
 * Everything the URL can say, read once, with the modes it implies named rather
 * than recomputed at each use.
 */

export type View = 'front' | 'side' | 'quarter' | 'top' | 'bust';

export type Options = {
    /** `?limb` — the one-joint diagnostic tube. */
    limb: boolean;
    /** `?figure` — the eleven-bone stick figure. */
    figure: boolean;
    /** `?editor` — one avatar on a plain stage, with the parameter panel. */
    editor: boolean;
    /** `?crowd=N` — a grid of N avatars, for measuring what one costs. */
    benchmark: number;
    /** `?seed=3` shows the third of the cast; seed 1 is the default. */
    seed: number;

    /** `?view=front|side|quarter|top|bust`, and `?face` for a tighter head framing. */
    view: View;
    face: boolean;
    /** `?cam=x,y,z` / `?look=x,y,z` override the framing outright. */
    cam: THREE.Vector3 | null;
    look: THREE.Vector3 | null;
    /** `?bg=ff00ff` — the quickest way to tell "no splats here" from "dark splats here". */
    background: number | null;

    /** `?expression=scared` holds the workbench avatar on one face. */
    expression: Expression;
    /** `?gaze=0.8,-0.2` points the workbench avatar's eyes, -1..1 each way. */
    gaze: [number, number];
    /** `?bend=85` and `?t=1.25` freeze the pose, in radians and seconds. */
    frozenBend: number | null;
    frozenTime: number | null;
    /** `?bounds` draws the box the crowd may wander inside. */
    bounds: boolean;
    /** `?sway` tints whatever the trees' wind claims, to check the volumes. */
    sway: boolean;
    /** `?bare` drops the capture, for judging silhouettes against a plain ground. */
    bare: boolean;
    /** `?stats` prints frame time to the console. */
    stats: boolean;

    /** Any of the single-rig views: one thing, close up, no crowd. */
    workbench: boolean;
    /** The finished thing: the crowd in its square. */
    townSquare: boolean;
};

const VIEWS: View[] = ['front', 'side', 'quarter', 'top', 'bust'];

export function readOptions(search = window.location.search): Options {
    const url = new URLSearchParams(search);
    const number = (key: string, fallback: number) => {
        const raw = url.get(key);
        return raw === null || raw === '' ? fallback : Number(raw);
    };
    const vector = (key: string) => {
        const parts = url.get(key)?.split(',').map(Number);
        return parts?.length === 3 && parts.every(Number.isFinite) ? new THREE.Vector3(...parts) : null;
    };

    const gaze = (url.get('gaze') ?? '').split(',').map(Number);
    const limb = url.has('limb');
    const figure = url.has('figure');
    const editor = url.has('editor');
    const benchmark = number('crowd', 0);
    // A named view or a face framing is a request to look at ONE of them.
    const workbench = limb || figure || editor || benchmark > 0 || url.has('view') || url.has('face');
    const view = VIEWS.find((v) => v === url.get('view')) ?? 'quarter';

    return {
        limb,
        figure,
        editor,
        benchmark,
        seed: number('seed', 1),
        view,
        face: url.has('face'),
        cam: vector('cam'),
        look: vector('look'),
        background: url.has('bg') ? Number.parseInt(url.get('bg') as string, 16) : null,
        expression: EXPRESSIONS.find((e) => e === url.get('expression')) ?? 'happy',
        // NaN || 0: a missing or garbled axis just looks ahead.
        gaze: [gaze[0] || 0, gaze[1] || 0],
        frozenBend: url.has('bend') ? THREE.MathUtils.degToRad(number('bend', 0)) : null,
        frozenTime: url.has('t') ? number('t', 0) : null,
        bounds: url.has('bounds'),
        sway: url.has('sway'),
        bare: url.has('bare') || limb || figure || editor,
        // A benchmark exists to be measured, so it turns stats on by itself.
        stats: url.has('stats') || benchmark > 0,
        workbench,
        /** The default: no switch asked for anything else. */
        townSquare: !workbench,
    };
}
