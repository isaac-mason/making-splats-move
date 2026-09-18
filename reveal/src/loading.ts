/**
 * The loading overlay.
 *
 * Styled in index.html rather than here so it's painted on the very first frame,
 * before the bundle has loaded — a loading screen that appears late has missed its
 * only job.
 */

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

export function setLoadingProgress(loading: Loading, event: ProgressEvent): void {
    // `lengthComputable` is false when the server sends no Content-Length, which is
    // common enough that an indeterminate state has to be a real state rather than a
    // bar stuck at zero.
    if (!event.lengthComputable || event.total === 0) {
        loading.label.textContent = `${(event.loaded / 1e6).toFixed(0)} MB`;
        loading.bar.style.width = '100%';
        loading.bar.style.opacity = '0.35';
        return;
    }
    const fraction = event.loaded / event.total;
    loading.bar.style.width = `${(fraction * 100).toFixed(1)}%`;
    loading.label.textContent = `${Math.round(fraction * 100)}%`;
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
