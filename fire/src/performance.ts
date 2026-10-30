import type { WebGPURenderer } from 'three/webgpu';

export type Performance = {
    renderScale: number;
};

export function initPerformance(): Performance {
    return { renderScale: 1 };
}

export function applyPerformance(perf: Performance, renderer: WebGPURenderer): void {
    const ratio = window.devicePixelRatio * perf.renderScale;
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
}
