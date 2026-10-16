/**
 * Perfect recordings: the frames rendered on a fixed clock and encoded in the page,
 * not a screen recording hoping to keep up. Each frame is exactly 1/fps on from the
 * last, at whatever size you ask for, so the file is constant-rate at any rate the
 * display can't do, and rendering slower than real time costs nothing.
 *
 * Encoding is WebCodecs (the hardware H.264 encoder, VP9 if it can't do the size and
 * rate) muxed to an MP4 in memory, then downloaded.
 *
 *   ?record=1&fps=120&seconds=12&width=1920&height=1080&mbps=60&stokes=3,8&sweep=0.8&warmup=4
 *
 * `warmup` seconds run before the first frame, unrecorded, so the fire is already
 * burning rather than lighting as the take starts.
 * `sweep` is a scripted mouse: it crosses the window from left to right over the
 * take, that far out of 1 each way, so the parallax lean is in the shot. Negative
 * goes right to left, 0 holds still.
 */

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export type Recording = {
    fps: number;
    seconds: number;
    width: number;
    height: number;
    /** Video bitrate, megabits per second. */
    mbps: number;
    /** Seconds into the take to stoke the fire, so a take repeats. */
    stokes: number[];
    /** Seconds simulated before the first frame, so the fire is already going. */
    warmup: number;
    /** How far the scripted mouse crosses the window, -1..1; its sign is the direction. */
    sweep: number;
};

export function recordingFromUrl(): Recording | null {
    const params = new URLSearchParams(location.search);
    if (!params.has('record')) return null;
    const num = (name: string, fallback: number) => {
        const value = Number(params.get(name));
        return params.has(name) && Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const sweep = Number(params.get('sweep') ?? 0.8);
    const stokes = (params.get('stokes') ?? '')
        .split(',')
        .map(Number)
        .filter((t) => Number.isFinite(t) && t >= 0)
        .sort((a, b) => a - b);
    return {
        fps: num('fps', 120),
        seconds: num('seconds', 10),
        width: Math.round(num('width', 1920) / 2) * 2,
        height: Math.round(num('height', 1080) / 2) * 2,
        mbps: num('mbps', 60),
        stokes,
        warmup: params.has('warmup') ? Math.max(0, Number(params.get('warmup')) || 0) : 4,
        sweep: Number.isFinite(sweep) ? Math.max(-1, Math.min(1, sweep)) : 0.8,
    };
}

/** H.264 at the level the size and rate need, else VP9. */
async function pickCodec(width: number, height: number, framerate: number, bitrate: number) {
    const candidates: [string, 'avc' | 'vp9'][] = [
        ['avc1.64003C', 'avc'],
        ['avc1.640034', 'avc'],
        ['avc1.640033', 'avc'],
        ['vp09.00.51.08', 'vp9'],
    ];
    for (const [codec, mux] of candidates) {
        const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate });
        if (supported) return { codec, mux };
    }
    throw new Error(`No video encoder for ${width}x${height} at ${framerate} fps`);
}

/**
 * Renders and encodes every frame of the take: `frame(index, time, dt)` must draw
 * frame `index` into `canvas` before it returns. Resolves to the MP4.
 */
export async function record(
    canvas: HTMLCanvasElement,
    { fps, seconds, width, height, mbps, warmup }: Recording,
    frame: (index: number, time: number, dt: number) => void,
    onProgress: (done: number, total: number) => void,
): Promise<Blob> {
    const total = Math.round(fps * seconds);
    const bitrate = mbps * 1e6;
    const { codec, mux } = await pickCodec(width, height, fps, bitrate);
    const dt = 1 / fps;

    // Negative frame indices: the warmup, stepped but not encoded.
    const lead = Math.round(fps * warmup);
    for (let f = -lead; f < 0; f++) {
        frame(f, f * dt, dt);
        onProgress(f, total);
        if (f % 8 === 0) await new Promise(requestAnimationFrame);
    }

    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: mux, width, height, frameRate: fps },
        fastStart: 'in-memory',
    });
    let failed: Error | null = null;
    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (error) => {
            failed = error;
        },
    });
    encoder.configure({
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        latencyMode: 'quality',
        ...(mux === 'avc' ? { avc: { format: 'avc' as const } } : {}),
    });

    const microseconds = Math.round(1e6 / fps);
    for (let f = 0; f < total; f++) {
        if (failed) throw failed;
        frame(f, f * dt, dt);
        const image = new VideoFrame(canvas, { timestamp: f * microseconds, duration: microseconds });
        encoder.encode(image, { keyFrame: f % fps === 0 });
        image.close();
        // Don't run away from the encoder, and let the page paint its progress.
        while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
        onProgress(f + 1, total);
        if (f % 4 === 3) await new Promise(requestAnimationFrame);
    }
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    if (failed) throw failed;
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

export function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
