// A rolling frame-time average, exposed on window.__windStats so you can compare
// the two wind paths from the console (or from an automated run) without a
// profiler. Cheap enough to leave on.
//
// Read it with a still camera on each path — the modifier path's sort readback
// shows up as a much larger, and much spikier, number.
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
            // Report a rolling average over ~half a second, so a single hitch
            // doesn't dominate the reading.
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
