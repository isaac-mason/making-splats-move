/**
 * How the avatars are drawn, in five steps sized for showing on screen: splat shapes
 * (1-shapes.ts), a face built from them (2-face.ts), a body (3-body.ts), that body
 * skinned to a few bones (4-skinning.ts), and a flower whose stem bends (5-bend.ts).
 * `?step=1..5`, or the buttons, pick one; `?bones` draws the skeleton.
 *
 * Drawn by spark-radix: the splats are built on the CPU into a table, and skinning
 * is a generator over it (splats.ts).
 */

import { createRenderer, type GpuArrays, SplatCollection, SplatRenderer } from 'spark-radix';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { shapes } from './1-shapes';
import { faceDemo } from './2-face';
import { body } from './3-body';
import { type Skinned, skinned } from './4-skinning';
import { bend } from './5-bend';
import { SKELETON } from './skeleton';
import { displayColor, type Skinning, SplatBuilder, splatObject } from './splats';
import './style.css';

const STEPS: { label: string; build: (mesh: SplatBuilder, holder: THREE.Object3D) => Skinned | undefined }[] = [
    { label: '1 · shapes', build: (mesh) => void shapes(mesh) },
    { label: '2 · face', build: (mesh) => void faceDemo(mesh) },
    { label: '3 · body', build: (mesh) => void body(mesh) },
    { label: '4 · skinning', build: skinned },
    { label: '5 · bend', build: bend },
];

const scene = new THREE.Scene();
scene.background = displayColor(0xf3efe6);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.0, 3.2);
// WebGPU, or the WebGL2 backend where it's missing. MSAA doesn't help splats.
const renderer = await createRenderer({ antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.querySelector('#app')?.appendChild(renderer.domElement);

const splats = new SplatRenderer({ renderer });
scene.add(splats);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.85, 0);
controls.enableDamping = true;

const count = document.createElement('div');
count.id = 'count';
const bar = document.createElement('div');
bar.id = 'steps';
const bones = document.createElement('button');
bones.id = 'bones';
let showBones = new URLSearchParams(location.search).has('bones');
bones.onclick = () => {
    showBones = !showBones;
    applyBones();
};
document.body.append(count, bar, bones);

function applyBones() {
    const skeleton = current?.holder.getObjectByName(SKELETON);
    if (skeleton) skeleton.visible = showBones;
    bones.hidden = !skeleton;
    bones.classList.toggle('active', showBones);
    bones.textContent = showBones ? 'hide bones' : 'show bones';
}

/** The step on show: its splats on the GPU, the group it's placed by, and its animation if any. */
let current: { holder: THREE.Group; arrays: GpuArrays; skinning?: Skinning; animate?: (time: number) => void } | null = null;

function show(step: number) {
    if (current) {
        scene.remove(current.holder);
        current.arrays.dispose();
        current.skinning?.dispose();
    }
    const holder = new THREE.Group();
    const mesh = new SplatBuilder();
    const animated = STEPS[step].build(mesh, holder);
    const data = mesh.build();
    const { object, arrays } = splatObject(renderer, data, holder, animated?.skinning);
    splats.collection = new SplatCollection([object]);
    scene.add(holder);
    current = { holder, arrays, skinning: animated?.skinning, animate: animated?.animate };

    applyBones();
    count.textContent = `${data.count.toLocaleString()} splats`;
    for (const [i, button] of bar.querySelectorAll('button').entries()) button.classList.toggle('active', i === step);
    history.replaceState(null, '', `?step=${step + 1}`);
}

STEPS.forEach((s, i) => {
    const button = document.createElement('button');
    button.textContent = s.label;
    button.onclick = () => show(i);
    bar.append(button);
});

const requested = Number(new URLSearchParams(location.search).get('step')) - 1;
show(requested >= 0 && requested < STEPS.length ? requested : 0);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop((now) => {
    if (current?.animate) {
        current.animate(now / 1000);
        current.skinning?.upload(renderer);
        // The bones move splats the CPU sort (WebGL2) can't see.
        if (splats.sortMode === 'cpu') splats.requestSort();
    }
    controls.update();
    renderer.render(scene, camera);
});
