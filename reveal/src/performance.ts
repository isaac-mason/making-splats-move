/**
 * Quality budget.
 *
 * Spark's LoD budget and foveation are gone with it: radix draws every splat of the
 * flat file every frame. What's left is the render scale, pushed onto the renderer
 * each frame from the debug panel, and a lighter Gaussian extent on phones.
 */

import type { SplatViewParams } from 'spark-radix';
import type { WebGPURenderer } from 'three/webgpu';

export type Performance = {
    /** Multiplier on the device pixel ratio: below 1 renders fewer pixels and upscales. */
    renderScale: number;
};

export function isMobile(): boolean {
    return navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches;
}

export function initPerformance(): Performance {
    return { renderScale: isMobile() ? 0.75 : 1 };
}

/** Fixed at construction, so it lives apart from the per-frame knob above. */
export function splatParams(): Partial<SplatViewParams> {
    return { maxStdDev: isMobile() ? Math.sqrt(5) : Math.sqrt(8) };
}

/** Cheap; safe to call every frame. */
export function applyPerformance(perf: Performance, renderer: WebGPURenderer): void {
    const ratio = window.devicePixelRatio * perf.renderScale;
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
}
