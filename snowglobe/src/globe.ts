/**
 * The globe: the anime city's street crossing cut into a diorama, under glass.
 *
 * The capture was shot from the street, so it never saw the tops and backs of
 * its buildings: from above they're smears of sky. A snow globe is looked down
 * into, so the diorama is cut like a miniature model: a disc round the crossing,
 * sliced off just above the shopfronts, its sky floaters and near-invisible
 * splats dropped, and the faint and tiny ones, which don't show from outside
 * the glass. scripts/crop-city.mjs does that once, to its own .spz, a sixth of
 * the city's splats (the cut is diorama.json).
 *
 * The glass is a sphere drawn after the splats: barely there, a faint rim where
 * you look across it and a small soft highlight, so the city shows through.
 */

import { type AnySplatObject, GpuArrays, loadSplats, SplatCollection, SplatGenerator, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import dioramaUrl from '../assets/diorama.spz?url';
import CUT from '../diorama.json';

const { abs, dot, max, mix, normalize, normalView, positionView, pow, vec3, vec4 } = TSL;

/** The cut, in the capture's own frame (metres): a disc round the crossing, sliced off above the shopfronts, on its base. */
export const DIORAMA = CUT;

/** The glass: a sphere this big, centred this high over the diorama's base, so the disc sits inside it with room above. */
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

/** The diorama: the city's crossing, cut. Decoded on a worker. */
export async function loadDiorama(renderer: WebGPURenderer): Promise<AnySplatObject> {
    const data = await loadSplats(dioramaUrl);
    const arrays = GpuArrays.fromData(renderer, data);
    return SplatCollection.object({ generator: SplatGenerator.fromSplats(), data: { splats: arrays }, count: arrays.count });
}

/** Where the glass's centre is. */
export const glassCentre = new THREE.Vector3(DIORAMA.centre[0], DIORAMA.base + GLASS.height, DIORAMA.centre[1]);

/** The glass: a faint rim where you look across it, and a small soft highlight; drawn after the splats. */
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
    // After the splats, so the city shows through it.
    mesh.renderOrder = 10;
    return mesh;
}
