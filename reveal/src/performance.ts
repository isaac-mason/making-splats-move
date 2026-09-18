import { isIos, isMobile, type SparkRenderer, type SparkRendererOptions } from '@sparkjsdev/spark';

/**
 * Quality budget, copied in spirit from wind/.
 *
 * Worth 26.1ms -> 21.2ms at a close camera, measured. Not the whole story though —
 * see the frame-time note in the README, where the camera turned out to matter more
 * than any of this.
 *
 * The `.rad` carries an LOD tree whether or not the mesh is paged, so these apply to
 * a resident load too: `paged: true` buys streaming and the paging budget, not LOD.
 * Measured at 22.0ms paged against 21.2ms resident — no difference worth the loss of
 * a real download to watch.
 */

/** What Spark aims to keep active. Unset, desktop defaults to ~2.5M — the whole file. */
const LOD_SPLATS = 2_000_000;
/**
 * Minimum on-screen splat size, in pixels. Spark discards anything smaller, and up to
 * about 5.0 is near-indistinguishable — the cheapest lever there is on active count.
 */
const LOD_RENDER_SCALE = 1.75;

/** Fixed at construction, so it lives apart from the per-frame knobs below. */
export function sparkQuality(): Pick<SparkRendererOptions, 'maxStdDev' | 'coneFov0' | 'coneFov' | 'coneFoveate'> {
    return {
        maxStdDev: isMobile() ? Math.sqrt(5) : Math.sqrt(8),
        // Full detail in the middle of frame, falling away toward the edges.
        coneFov0: 60,
        coneFov: 110,
        coneFoveate: isIos() ? 0.35 : 0.5,
    };
}

/** Cheap; safe to call every frame. */
export function applyPerformance(spark: SparkRenderer): void {
    spark.lodSplatCount = isMobile() ? LOD_SPLATS / 2 : LOD_SPLATS;
    spark.lodRenderScale = LOD_RENDER_SCALE;
}
