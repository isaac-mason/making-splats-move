import * as THREE from 'three';
import { type Avatar, initAvatar, updateAvatar } from './avatar';
import {
    type AvatarEditor,
    createAvatarEditor,
    setAvatarEditorVisible,
    syncAvatarEditor,
    updateAvatarEditor,
} from './avatar-editor';
import { CAST } from './avatar-params';
import { type Figure, initFigure, updateFigure } from './figure';
import { initLimb, JOINT_Y, type Limb, setLimbBend } from './limb';
import type { Options } from './options';

/**
 * One rig on a plain stage: `?limb` the one-joint tube this started as, `?figure` the
 * stick figure, `?editor` an avatar with the parameter panel, `?crowd=N` a grid for
 * measuring cost.
 *
 * Kept because they fail far more legibly than a finished character does — a banded
 * lattice tube makes a skinning bug unmissable, where on a face you'd just think it
 * looked a bit off.
 */

export type Workbench = {
    limb: Limb | null;
    /** The rig `?figure` and `?editor` drive. Swapped out wholesale on a rebuild. */
    rig: Avatar | Figure | null;
    editor: AvatarEditor | null;
    /** The `?crowd=N` grid. */
    benchmark: Avatar[];
};

// Held for a beat at each end, so a still frame is likely to catch it clearly bent.
const MAX_BEND = THREE.MathUtils.degToRad(85);
/** Gait phase per second for the solo rigs, which have no speed to derive it from. */
const SOLO_GAIT = 2.9;

export function initWorkbench(scene: THREE.Scene, camera: THREE.PerspectiveCamera, options: Options): Workbench {
    const bench: Workbench = { limb: null, rig: null, editor: null, benchmark: [] };

    if (options.limb) {
        bench.limb = initLimb();
        scene.add(bench.limb.mesh);
        scene.add(...restPoseGuides());
    }
    if (options.figure) {
        bench.rig = initFigure();
        scene.add(bench.rig.mesh);
    }

    // `?view` or `?face` with no rig named: one avatar, framed how they asked.
    if (!options.limb && !options.figure && !options.editor && options.benchmark === 0) {
        bench.rig = initAvatar(castMember(options.seed), options.seed);
        scene.add(bench.rig.mesh);
    }

    if (options.editor) {
        // A rebuild regenerates every splat, rebinds every weight and recompiles the
        // generator, so it swaps the whole mesh rather than editing one.
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
        const splats = bench.benchmark.reduce((n, a) => n + a.mesh.numSplats, 0);
        const built = (performance.now() - started).toFixed(0);
        console.log(`crowd: ${options.benchmark} avatars, ${splats.toLocaleString()} splats, built in ${built}ms`);
        camera.position.set(0, 1.6, 2.2 + side * 1.4);
    }

    return bench;
}

/**
 * They differ when `?t=` freezes the pose: the limb keeps swinging so you can see the
 * page is live, while the character holds still so you can read it.
 */
export function updateWorkbench(bench: Workbench, options: Options, posedTime: number, wallTime: number): void {
    if (bench.limb) {
        const swing = Math.sin(wallTime * 0.7);
        setLimbBend(bench.limb, options.frozenBend ?? MAX_BEND * Math.sign(swing) * Math.abs(swing) ** 0.45);
    }
    if (bench.editor) updateAvatarEditor(bench.editor);
    if (bench.rig) {
        if (bench.rig.kind === 'avatar') {
            bench.rig.expression = options.expression;
            bench.rig.gaze.set(...options.gaze);
            updateAvatar(bench.rig, posedTime * SOLO_GAIT);
        } else updateFigure(bench.rig, posedTime * SOLO_GAIT);
    }
    for (const avatar of bench.benchmark) updateAvatar(avatar, posedTime * SOLO_GAIT);
}

export function workbenchSplats(bench: Workbench): number {
    const solo = (bench.limb?.mesh ?? bench.rig?.mesh)?.numSplats ?? 0;
    return bench.benchmark.reduce((n, a) => n + a.mesh.numSplats, solo);
}

/** So "did it bend?" isn't opinion: at rest the tube sits exactly on this line. */
function restPoseGuides(): THREE.Object3D[] {
    const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2, 0)]),
        new THREE.LineBasicMaterial({ color: 0x445066 }),
    );
    const joint = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff3366 }));
    joint.position.set(0, JOINT_Y, 0);
    return [line, joint];
}

/** `?seed=N` picks the Nth of the cast, wrapping. */
function castMember(seed: number) {
    return CAST[(((seed - 1) % CAST.length) + CAST.length) % CAST.length];
}
