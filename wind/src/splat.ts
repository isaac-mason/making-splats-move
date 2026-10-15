import { GpuArrays, loadSplats, SplatCollection, SplatGenerator, type SplatModifier, SplatRenderer } from 'spark-radix';
import type * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { SPLAT_URL } from './scene';

export type Splat = {
    /** Draws the capture, sorted, with the wind on it. */
    splats: SplatRenderer;
    /** Splats in the capture. */
    count: number;
};

/**
 * Load the scene's capture and put it in a SplatRenderer, with the wind as a
 * modifier on its generator (object space; the capture sits at the origin, so
 * that's world space). Everything splat-specific lives here so index.ts stays
 * about wiring systems together.
 */
export async function createSplat(scene: THREE.Scene, renderer: WebGPURenderer, modifier: SplatModifier): Promise<Splat> {
    // Decoded on a worker.
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
