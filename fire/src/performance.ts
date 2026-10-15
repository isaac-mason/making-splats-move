/**
 * Runtime quality settings, tweaked live from the debug panel and pushed onto the
 * renderer each frame. New perf knobs belong here.
 */

import type { WebGPURenderer } from 'three/webgpu';

export type Performance = {
    /** Multiplier on the device pixel ratio: below 1 renders fewer pixels and upscales. */
    renderScale: number;
};

export function initPerformance(): Performance {
    return { renderScale: 1 };
}

export function applyPerformance(perf: Performance, renderer: WebGPURenderer): void {
    const ratio = window.devicePixelRatio * perf.renderScale;
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
}
