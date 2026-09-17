import type { SparkRenderer } from '@sparkjsdev/spark';

// Runtime performance / quality settings, separate from debug. Tweak them live
// (e.g. via the debug panel's slider) and applyPerformance() pushes them onto the
// renderer each frame. New perf knobs (pixel ratio, foveation, sort interval, …)
// belong here too.
export type Performance = {
    /** LOD splat-budget multiplier on the SparkRenderer (1 = its platform default). */
    lodScale: number;
};

export function initPerformance(): Performance {
    return { lodScale: 0.8 };
}

// Push the current settings onto the SparkRenderer. Cheap; safe to call each frame.
export function applyPerformance(perf: Performance, spark: SparkRenderer): void {
    spark.lodSplatScale = perf.lodScale;
}
