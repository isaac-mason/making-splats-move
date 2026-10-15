/**
 * One avatar on a plain stage, for looking at closely: `?view` and `?face` frame it,
 * `?editor` adds the parameter panel, `?crowd=N` lays out a grid for measuring cost.
 */

import type * as THREE from 'three';
import { type Avatar, initAvatar, updateAvatar } from './avatar';
import {
    type AvatarEditor,
    createAvatarEditor,
    setAvatarEditorVisible,
    syncAvatarEditor,
    updateAvatarEditor,
} from './avatar-editor';
import { CAST } from './avatar-params';
import type { Options } from './options';

export type Workbench = {
    /** The one avatar on show. `?editor` swaps it out wholesale on a rebuild. */
    rig: Avatar | null;
    editor: AvatarEditor | null;
    /** The `?crowd=N` grid. */
    benchmark: Avatar[];
};

/** Gait phase per second for the solo rigs, which have no speed to derive it from. */
const SOLO_GAIT = 2.9;

export function initWorkbench(scene: THREE.Scene, camera: THREE.PerspectiveCamera, options: Options): Workbench {
    const bench: Workbench = { rig: null, editor: null, benchmark: [] };

    // `?view` or `?face` on its own: one avatar, framed how they asked.
    if (!options.editor && options.benchmark === 0) {
        bench.rig = initAvatar(castMember(options.seed), options.seed);
        scene.add(bench.rig.mesh);
    }

    if (options.editor) {
        // A rebuild regenerates every splat and rebinds every weight, so it swaps the
        // whole avatar rather than editing one.
        bench.editor = createAvatarEditor((next) => {
            if (bench.rig) {
                scene.remove(bench.rig.mesh);
                bench.rig.dispose();
            }
            bench.rig = initAvatar(next, options.seed);
            scene.add(bench.rig.mesh);
        });
        if (options.seed !== 1) {
            Object.assign(bench.editor.params, castMember(options.seed));
            syncAvatarEditor(bench.editor);
        }
        bench.rig = initAvatar(bench.editor.params, options.seed);
        scene.add(bench.rig.mesh);
        setAvatarEditorVisible(bench.editor, true);
    }

    if (options.benchmark > 0) {
        const side = Math.ceil(Math.sqrt(options.benchmark));
        const started = performance.now();
        for (let i = 0; i < options.benchmark; i++) {
            const avatar = initAvatar(castMember(i + 1), i + 1);
            const x = ((i % side) - (side - 1) / 2) * 1.1;
            const z = (Math.floor(i / side) - (side - 1) / 2) * 1.1;
            avatar.mesh.position.set(x, 0, z);
            scene.add(avatar.mesh);
            bench.benchmark.push(avatar);
        }
        const splats = bench.benchmark.reduce((n, a) => n + a.count, 0);
        const built = (performance.now() - started).toFixed(0);
        console.log(`crowd: ${options.benchmark} avatars, ${splats.toLocaleString()} splats, built in ${built}ms`);
        camera.position.set(0, 1.6, 2.2 + side * 1.4);
    }

    return bench;
}

/** `posedTime` is the walk's clock — `?t=` freezes it, so a still pose can be read. */
export function updateWorkbench(bench: Workbench, options: Options, posedTime: number): void {
    if (bench.editor) updateAvatarEditor(bench.editor);
    if (bench.rig) {
        bench.rig.expression = options.expression;
        bench.rig.gaze.set(...options.gaze);
        updateAvatar(bench.rig, posedTime * SOLO_GAIT);
    }
    for (const avatar of bench.benchmark) updateAvatar(avatar, posedTime * SOLO_GAIT);
}

export function workbenchSplats(bench: Workbench): number {
    return bench.benchmark.reduce((n, a) => n + a.count, bench.rig?.count ?? 0);
}

/** `?seed=N` picks the Nth of the cast, wrapping. */
function castMember(seed: number) {
    return CAST[(((seed - 1) % CAST.length) + CAST.length) % CAST.length];
}
