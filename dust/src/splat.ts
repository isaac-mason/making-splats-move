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
 * The asset is an LOD-paged `.rad` (see the README's asset pipeline), which is what
 * the paging budget in src/performance.ts is for — `pagedExtSplats` and
 * `maxPagedSplats` have nothing to do against a flat `.spz`, because a flat file
 * carries no cheaper version of anything to fall back to.
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

    // `paged: true` STREAMS the .rad rather than loading it resident, and that's all
    // it does — the file loads and gives you LOD either way, because `.rad` is an
    // auto-detected format (SplatLoader maps the extension to SplatFileType.RAD) and
    // the LOD tree is encoded in the file. What the flag buys is instant start plus
    // the paging machinery: SplatPager, and with it the `pagedExtSplats` /
    // `maxPagedSplats` budget. Pages are pulled with HTTP range requests, so
    // whatever serves this has to support them.
    const mesh = new SplatMesh({ url: SPLAT_URL, paged: true });
    mesh.scale.setScalar(SPLAT_SCALE);
    scene.add(mesh);

    return { spark, mesh };
}
