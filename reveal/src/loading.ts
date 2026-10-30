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

export function setLoadingProgress(loading: Loading, fraction: number, stage: ProgressStage): void {
    loading.bar.style.width = `${(fraction * 100).toFixed(1)}%`;
    loading.label.textContent = stage === 'downloading' ? `${Math.round(fraction * 100)}%` : stage;
}

export function finishLoading(loading: Loading): void {
    loading.element.classList.add('hidden');
    // Removed rather than left transparent, so it can never eat a pointer event.
    setTimeout(() => loading.element.remove(), 400);
}
