import type { SplatViewParams } from 'spark-radix';
import type { WebGPURenderer } from 'three/webgpu';

export type Performance = {
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

export function applyPerformance(perf: Performance, renderer: WebGPURenderer): void {
    const ratio = window.devicePixelRatio * perf.renderScale;
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
}
