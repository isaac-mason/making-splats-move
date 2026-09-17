import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type * as THREE from 'three';

import { getSparkQualityOptions } from './performance';
import { SPLAT_SCALE, SPLAT_URL } from './scene';

export type Splat = {
    /** Drives splat sorting; also carries the runtime perf knobs. */
    spark: SparkRenderer;
    /** The greenhouse mesh. */
    mesh: SplatMesh;
};

/**
 * Build the SparkRenderer and load the scene's SplatMesh, adding both to the scene.
 *
 * This asset is a plain `.spz`, not an LOD-paged `.rad`, so every splat is resident
 * and drawn every frame — fine at this size, and it keeps the example to one file
 * you can point at your own export. See the README for building a `.rad` instead.
 */
export function createSplat(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Splat {
    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
        ...getSparkQualityOptions(),
    });
    scene.add(spark);

    const mesh = new SplatMesh({ url: SPLAT_URL });
    mesh.scale.setScalar(SPLAT_SCALE);
    scene.add(mesh);

    return { spark, mesh };
}
