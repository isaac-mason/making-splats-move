/**
 * How the avatars are drawn, in five steps sized for showing on screen: splat shapes
 * (1-shapes.ts), a face built from them (2-face.ts), a body (3-body.ts), that body
 * skinned to a few bones (4-skinning.ts), and a flower whose stem bends (5-bend.ts).
 * `?step=1..5`, or the buttons, pick one; `?bones` draws the skeleton.
 */

import { SparkRenderer, type SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createMesh, shapes } from './1-shapes';
import { faceDemo } from './2-face';
import { body } from './3-body';
import { skinned } from './4-skinning';
import { bend } from './5-bend';
import { SKELETON } from './skeleton';
import './style.css';

let animate: ((time: number) => void) | undefined;

const STEPS: { label: string; build: (mesh: SplatMesh) => void }[] = [
    { label: '1 · shapes', build: shapes },
    { label: '2 · face', build: faceDemo },
    { label: '3 · body', build: body },
    {
        label: '4 · skinning',
        build: (mesh) => {
            animate = skinned(mesh);
        },
    },
    {
        label: '5 · bend',
        build: (mesh) => {
            animate = bend(mesh);
        },
    },
];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf3efe6);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.0, 3.2);
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.querySelector('#app')?.appendChild(renderer.domElement);
scene.add(new SparkRenderer({ renderer }));

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
    const skeleton = mesh?.getObjectByName(SKELETON);
    if (skeleton) skeleton.visible = showBones;
    bones.hidden = !skeleton;
    bones.classList.toggle('active', showBones);
    bones.textContent = showBones ? 'hide bones' : 'show bones';
}

let mesh: SplatMesh | null = null;

function show(step: number) {
    if (mesh) {
        scene.remove(mesh);
        mesh.dispose();
    }
    mesh = createMesh();
    animate = undefined;
    STEPS[step].build(mesh);
    mesh.numSplats = mesh.packedSplats?.numSplats ?? 0;
    if (mesh.packedSplats) mesh.packedSplats.needsUpdate = true;
    scene.add(mesh);

    applyBones();
    count.textContent = `${mesh.numSplats.toLocaleString()} splats`;
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
    animate?.(now / 1000);
    controls.update();
    renderer.render(scene, camera);
});
