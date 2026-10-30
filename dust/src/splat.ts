import { type AnySplatObject, GpuArrays, loadSplats, SplatCollection, type SplatData } from 'spark-radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { SPLAT_SCALE, SPLAT_URL } from './scene';

export type Splat = {
    object: AnySplatObject;
    count: number;
    data: SplatData;
};

export async function createSplat(renderer: WebGPURenderer): Promise<Splat> {
    const data = await loadSplats(SPLAT_URL);
    const arrays = GpuArrays.fromData(renderer, data);
    const matrixWorld = new THREE.Matrix4().makeScale(SPLAT_SCALE, SPLAT_SCALE, SPLAT_SCALE);
    return { object: SplatCollection.arrays(arrays, { matrixWorld }), count: arrays.count, data };
}
