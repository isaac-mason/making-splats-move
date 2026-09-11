import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type * as THREE from 'three';

import { getSparkQualityOptions } from './performance';
import { SPLAT_URL } from './scene';
import { applyWind } from './wind';

export type Splat = {
    /** Drives splat sorting + LOD streaming; also carries the runtime perf knobs. */
    spark: SparkRenderer;
    /** The scene's Gaussian-splat mesh. */
    mesh: SplatMesh;
};

/**
 * Build the SparkRenderer and load the scene's SplatMesh, adding both to the scene.
 * Everything splat-specific (LOD cone, quality budget, wind modifier) lives here so
 * index.ts stays about wiring systems together.
 */
export function createSplat(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Splat {
    // SparkRenderer drives splat sorting and LOD streaming/updates for the .rad file.
    // Widen the LOD foveation cone so splats near the screen corners stay full-res
    // (defaults: coneFov0 90, coneFov 120, coneFoveate 0.4).
    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
        // Per-platform LOD paging + spread budget (iOS < other mobile < desktop).
        ...getSparkQualityOptions(),
    });
    scene.add(spark);

    // `paged: true` makes this an LOD-streaming (paged) mesh, which is what
    // activates the SparkRenderer's paging budget (pagedExtSplats / maxPagedSplats,
    // see src/performance.ts). Without it the whole .rad loads resident and that
    // budget is inert. Paging streams pages from the .rad rootUrl via HTTP range
    // requests, so the host must support them.
    const mesh = new SplatMesh({ url: SPLAT_URL, paged: true });

    scene.add(mesh);

    // Wind/sway: a per-splat vertex modifier (Spark's answer to PlayCanvas's
    // gsplatModifyVS). Currently a height-masked global sway — see src/wind.ts.
    applyWind(mesh);

    return { spark, mesh };
}
