import { GpuArrays, loadSplats, SplatCollection, SplatGenerator, type SplatModifier, SplatRenderer } from 'spark-radix';
import type * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { SPLAT_URL } from './scene';

export type Splat = {
    splats: SplatRenderer;
    count: number;
};

export async function createSplat(scene: THREE.Scene, renderer: WebGPURenderer, modifier: SplatModifier): Promise<Splat> {
    const data = await loadSplats(SPLAT_URL);
    const arrays = GpuArrays.fromData(renderer, data);

    const capture = SplatCollection.object({
        generator: SplatGenerator.fromSplats({ modifiers: [modifier] }),
        data: { splats: arrays },
        count: arrays.count,
    });

    const splats = new SplatRenderer({ renderer, collection: new SplatCollection([capture]) });
    splats.raycast = () => {};
    scene.add(splats);

    return { splats, count: arrays.count };
}
