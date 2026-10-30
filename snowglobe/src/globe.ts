import { type AnySplatObject, GpuArrays, loadSplats, SplatCollection, SplatGenerator, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import dioramaUrl from '../assets/diorama.spz?url';
import CUT from '../diorama.json';

const { abs, dot, max, mix, normalize, normalView, positionView, pow, vec3, vec4 } = TSL;

export const DIORAMA = CUT;

export const GLASS = {
    radius: 17,
    height: 5,
    rim: '#dfe8ff',
    rimStrength: 0.1,
    highlight: [-0.45, 0.55, 0.7],
    shine: 160,
    shineStrength: 0.25,
};

const colour = (hex: string): TslNode => {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
};

export async function loadDiorama(renderer: WebGPURenderer): Promise<AnySplatObject> {
    const data = await loadSplats(dioramaUrl);
    const arrays = GpuArrays.fromData(renderer, data);
    return SplatCollection.object({ generator: SplatGenerator.fromSplats(), data: { splats: arrays }, count: arrays.count });
}

export const glassCentre = new THREE.Vector3(DIORAMA.centre[0], DIORAMA.base + GLASS.height, DIORAMA.centre[1]);

export function glass(): THREE.Mesh {
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const towardsEye = normalize(positionView.negate());
    const across = pow(abs(dot(normalView, towardsEye)).oneMinus(), 3);
    const window = normalize(vec3(GLASS.highlight[0], GLASS.highlight[1], GLASS.highlight[2]));
    const shine = pow(max(dot(normalView, normalize(window.add(towardsEye))), 0), GLASS.shine);
    material.colorNode = vec4(mix(colour(GLASS.rim), vec3(1), shine), 1);
    material.opacityNode = across.mul(GLASS.rimStrength).add(shine.mul(GLASS.shineStrength)).min(1);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(GLASS.radius, 128, 96), material);
    mesh.position.copy(glassCentre);
    mesh.renderOrder = 10;
    return mesh;
}
