import * as THREE from 'three';

import { EXPRESSIONS, type Expression } from './avatar';

export type View = 'front' | 'side' | 'quarter' | 'top' | 'bust';

export type Options = {
    editor: boolean;
    benchmark: number;
    seed: number;

    view: View;
    face: boolean;
    cam: THREE.Vector3 | null;
    look: THREE.Vector3 | null;
    background: number | null;

    expression: Expression;
    gaze: [number, number];
    frozenTime: number | null;
    bare: boolean;
    stats: boolean;

    workbench: boolean;
    courtyard: boolean;
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
    const editor = url.has('editor');
    const benchmark = number('crowd', 0);
    const workbench = editor || benchmark > 0 || url.has('view') || url.has('face');
    const view = VIEWS.find((v) => v === url.get('view')) ?? 'quarter';

    return {
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
        frozenTime: url.has('t') ? number('t', 0) : null,
        bare: url.has('bare') || editor,
        stats: url.has('stats') || benchmark > 0,
        workbench,
        courtyard: !workbench,
    };
}
