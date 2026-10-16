/**
 * Perfect recordings: the frames rendered on a fixed clock and encoded in the page,
 * not a screen recording hoping to keep up. Each frame is exactly 1/fps on from the
 * last, at whatever size you ask for, so the file is constant-rate at any rate the
 * display can't do, and rendering slower than real time costs nothing.
 *
 * Encoding is WebCodecs (the hardware H.264 encoder, VP9 if it can't do the size and
 * rate) muxed to an MP4 in memory, then downloaded.
 *
 *   ?record=1&fps=120&seconds=12&width=1920&height=1080&mbps=60&stokes=3,8&warmup=4&sweep=1.8&rise=0.5&period=2.5&seed=1
 *
 * `warmup` seconds run before the first frame, unrecorded, so the fire is already
 * burning rather than lighting as the take starts.
 *
 * The scripted mouse stands in for a hand idly moving one: it heads somewhere,
 * eases there with a bit of overshoot, rests a moment, heads somewhere else, and
 * never quite holds still. `sweep` wide and `rise` tall, where 1 is the window's
 * edge and up to 2 goes past it; `period` seconds per move, roughly; `seed` picks
 * the pattern, and the same seed gives the same take.
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
    /** The scripted mouse's half-width, 0..2, where 1 is the window's edge. */
    sweep: number;
    /** Its half-height, 0..2. */
    rise: number;
    /** Seconds per swing, roughly: the sway is several sines, not a loop. */
    period: number;
    /** The hand's pattern. */
    seed: number;
};

export function recordingFromUrl(): Recording | null {
    const params = new URLSearchParams(location.search);
    if (!params.has('record')) return null;
    const num = (name: string, fallback: number) => {
        const value = Number(params.get(name));
        return params.has(name) && Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const unit = (name: string, fallback: number) => {
        const value = Number(params.get(name));
        return params.has(name) && Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : fallback;
    };
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
        sweep: unit('sweep', 1.8),
        rise: unit('rise', 0.5),
        period: num('period', 2.5),
        seed: num('seed', 1),
    };
}

/* the hand */

/** A small deterministic generator, so a seed is a take. */
function prng(seed: number): () => number {
    let a = (seed * 0x9e3779b9) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Move = {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    start: number;
    duration: number;
    /** How abrupt the ease is. */
    sharp: number;
    /** How far past the mark it goes before settling. */
    over: number;
    /** The pause after, seconds. */
    rest: number;
};

/**
 * Where the hand has the mouse at `time`, in window coordinates. Call with time
 * never decreasing: the moves are made up as they're reached.
 */
export function scriptedMouse({ sweep, rise, period, seed, warmup }: Recording): (time: number) => [number, number] {
    const random = prng(seed);
    const between = (lo: number, hi: number) => lo + (hi - lo) * random();
    const stroke = (x0: number, y0: number, x1: number, start: number): Move => ({
        x0,
        y0,
        x1,
        y1: between(-1, 1) * rise,
        start,
        duration: between(0.7, 1.4) * period,
        sharp: between(1.6, 2.6),
        over: between(0, 0.1),
        rest: between(0, 0.5) * period,
    });
    let move = stroke(0, 0, between(-1, 1) * sweep, -warmup);
    const next = (from: Move): Move => {
        // Mostly across the window, since that's what a hand idly does with it.
        const side = Math.sign(from.x1 || 1) * (random() < 0.7 ? -1 : 1);
        return stroke(from.x1, from.y1, side * between(0.3, 1) * sweep, from.start + from.duration + from.rest);
    };
    return (time) => {
        while (time >= move.start + move.duration + move.rest) move = next(move);
        const u = Math.min(1, Math.max(0, (time - move.start) / move.duration));
        // Ease in and out, sharper or softer per move, and a little past the mark.
        const a = u ** move.sharp;
        const eased = a / (a + (1 - u) ** move.sharp);
        const k = eased + Math.sin(Math.PI * u) * move.over;
        // The hand is never perfectly still.
        const wobble = (phase: number, rate: number) => Math.sin(2 * Math.PI * (time * rate + phase));
        return [
            move.x0 + (move.x1 - move.x0) * k + 0.03 * wobble(0.1, 0.7) + 0.015 * wobble(0.6, 1.9),
            move.y0 + (move.y1 - move.y0) * k + 0.03 * wobble(0.4, 0.9) + 0.015 * wobble(0.2, 2.3),
        ];
    };
}

/* encoding */

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
