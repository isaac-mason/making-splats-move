import { isIos, isMobile, type SparkRenderer, type SparkRendererOptions } from '@sparkjsdev/spark';

// Runtime performance / quality settings, separate from debug. Tweak them live
// (e.g. via the debug panel's slider) and applyPerformance() pushes them onto the
// renderer each frame. New perf knobs (pixel ratio, foveation, sort interval, …)
// belong here too.
export type Performance = {
    /**
     * Absolute LOD target: the number of splats Spark aims to keep active. This is
     * the primary lever on `spark.activeSplats`. Left unset, Spark uses a per-platform
     * base (~2.5M desktop / 1–1.5M mobile) which — combined with our wide foveation
     * cones — was landing around 4M. Pin it for a predictable budget.
     */
    lodCount: number;
    /** Multiplier applied on top of `lodCount` (1 = use the target as-is). */
    lodScale: number;
    /**
     * Minimum on-screen splat size, in pixels. Spark culls splats that would render
     * smaller than this. 1.0 is the default; raising it (up to ~5) discards tiny
     * sub-pixel splats — a near-invisible quality hit that directly cuts the active
     * count, so it's the cheapest lever for pulling `activeSplats` down.
     */
    lodRenderScale: number;
};

export function initPerformance(): Performance {
    return { lodCount: 2_000_000, lodScale: 1.0, lodRenderScale: 1.75 };
}

// Construction-time SparkRenderer quality budget, tuned per platform. Unlike the
// runtime knobs above these are fixed at renderer creation, so they live in their
// own helper spread into the `new SparkRenderer(...)` call.
//
// `maxPagedSplats` caps the LOD paging budget (in units of 65536-splat pages) and
// `maxStdDev` clamps per-splat spread — lower on mobile to keep memory + fill-rate
// in check. iOS gets the tightest budget (Safari/WebGL memory pressure), other
// mobile a middle tier, desktop the full budget.
export function getSparkQualityOptions(): Pick<SparkRendererOptions, 'maxStdDev' | 'pagedExtSplats' | 'maxPagedSplats'> {
    const mobile = isMobile();
    const ios = isIos();

    const maxStdDev = mobile ? Math.sqrt(5) : Math.sqrt(8);

    let maxPages: number;
    if (ios) {
        maxPages = 56;
    } else if (mobile) {
        maxPages = 96;
    } else {
        maxPages = 256;
    }

    return {
        maxStdDev,
        pagedExtSplats: true,
        maxPagedSplats: maxPages * 65536,
    };
}

// Push the current settings onto the SparkRenderer. Cheap; safe to call each frame.
export function applyPerformance(perf: Performance, spark: SparkRenderer): void {
    spark.lodSplatCount = perf.lodCount;
    spark.lodSplatScale = perf.lodScale;
    spark.lodRenderScale = perf.lodRenderScale;
}
