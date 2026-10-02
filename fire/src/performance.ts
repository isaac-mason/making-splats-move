/**
 * Runtime quality settings, tweaked live from the debug panel and pushed onto the
 * renderer each frame. New perf knobs (pixel ratio, foveation, …) belong here.
 */

import type { SparkRenderer } from '@sparkjsdev/spark';

export type Performance = {
    /** Multiplier on Spark's LOD splat budget (1 = its platform default). */
    lodScale: number;
};

export function initPerformance(): Performance {
    return { lodScale: 0.8 };
}

export function applyPerformance(perf: Performance, spark: SparkRenderer): void {
    spark.lodSplatScale = perf.lodScale;
}
