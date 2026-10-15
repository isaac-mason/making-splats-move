/**
 * The loading overlay.
 *
 * Styled in index.html rather than here so it's painted on the very first frame,
 * before the bundle has loaded — a loading screen that appears late has missed its
 * only job.
 */

import type { ProgressStage } from 'spark-radix';

export type Loading = {
    element: HTMLElement;
    bar: HTMLElement;
    label: HTMLElement;
};

export function initLoading(): Loading {
    const element = document.getElementById('loading') as HTMLElement;
    return {
        element,
        bar: element.querySelector('.bar-fill') as HTMLElement,
        label: element.querySelector('.label') as HTMLElement,
    };
}

/** radix reports one fraction across the download and the decode, with the stage it's in. */
export function setLoadingProgress(loading: Loading, fraction: number, stage: ProgressStage): void {
    loading.bar.style.width = `${(fraction * 100).toFixed(1)}%`;
    loading.label.textContent = stage === 'downloading' ? `${Math.round(fraction * 100)}%` : stage;
}

/**
 * Fades fast — 0.35s, not the 0.8s it started at.
 *
 * The overlay's background is a near-black gradient, so anything slower sits on top
 * of the first second of the reveal, which is the part worth watching.
 */
export function finishLoading(loading: Loading): void {
    loading.element.classList.add('hidden');
    // Removed rather than left transparent, so it can never eat a pointer event.
    setTimeout(() => loading.element.remove(), 400);
}
