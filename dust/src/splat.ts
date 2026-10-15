/**
 * The greenhouse: loaded on a worker, uploaded once, and placed as one object the
 * dust shares a collection (and so a sort) with.
 */

import { type AnySplatObject, GpuArrays, loadSplats, SplatCollection } from 'spark-radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { SPLAT_SCALE, SPLAT_URL } from './scene';

export type Splat = {
    object: AnySplatObject;
    count: number;
};

export async function createSplat(renderer: WebGPURenderer): Promise<Splat> {
    const data = await loadSplats(SPLAT_URL);
    const arrays = GpuArrays.fromData(renderer, data);
    const matrixWorld = new THREE.Matrix4().makeScale(SPLAT_SCALE, SPLAT_SCALE, SPLAT_SCALE);
    return { object: SplatCollection.arrays(arrays, { matrixWorld }), count: arrays.count };
}
