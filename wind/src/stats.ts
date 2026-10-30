// Rolling frame time on window.__windStats, to compare the two wind paths from the console.
export type Stats = { frameMs: number; frames: number };

export function initStats(): Stats {
    const stats: Stats = { frameMs: 0, frames: 0 };
    let last = performance.now();
    let accum = 0;
    let n = 0;

    (window as unknown as { __windStats: Stats }).__windStats = stats;

    return Object.assign(stats, {
        tick() {
            const now = performance.now();
            accum += now - last;
            last = now;
            n++;
            if (accum >= 500) {
                stats.frameMs = accum / n;
                stats.frames = n;
                accum = 0;
                n = 0;
            }
        },
    });
}

export function tickStats(stats: Stats): void {
    (stats as Stats & { tick(): void }).tick();
}
