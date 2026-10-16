/**
 * Perfect recordings: the frames rendered on a fixed clock and encoded in the page,
 * not a screen recording hoping to keep up. Each frame is exactly 1/fps on from the
 * last, at whatever size you ask for, so the file is constant-rate at any rate the
 * display can't do, and rendering slower than real time costs nothing.
 *
 * Encoding is WebCodecs (the hardware H.264 encoder, VP9 if it can't do the size and
 * rate) muxed to an MP4 in memory, then downloaded.
 *
 *   ?record=1&fps=120&seconds=12&width=1920&height=1080&mbps=60&stokes=3,8&warmup=4&path=-1.1:-0.1@0,1.3:0.3@5,-0.5@10
 *
 * `warmup` seconds run before the first frame, unrecorded, so the fire is already
 * burning rather than lighting as the take starts.
 *
 * The camera move is a path of keyframes, `path=x[:y]@seconds,...` in the lean's
 * window coordinates (1 is the window's edge), splined so the velocity never
 * breaks, with a faint breath on top. Left out, it's one slow gesture sized to the
 * take: in from the left, over, and part way back.
 */

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export type Key = { t: number; x: number; y: number };

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
    /** The camera move: where the lean heads, at seconds into the take. */
    path: Key[];
};

export function recordingFromUrl(): Recording | null {
    const params = new URLSearchParams(location.search);
    if (!params.has('record')) return null;
    const num = (name: string, fallback: number) => {
        const value = Number(params.get(name));
        return params.has(name) && Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const stokes = (params.get('stokes') ?? '')
        .split(',')
        .map(Number)
        .filter((t) => Number.isFinite(t) && t >= 0)
        .sort((a, b) => a - b);
    const seconds = num('seconds', 10);
    return {
        fps: num('fps', 120),
        seconds,
        width: Math.round(num('width', 1920) / 2) * 2,
        height: Math.round(num('height', 1080) / 2) * 2,
        mbps: num('mbps', 60),
        stokes,
        warmup: params.has('warmup') ? Math.max(0, Number(params.get('warmup')) || 0) : 4,
        path: parsePath(params.get('path'), seconds),
    };
}

/* the move */

/**
 * The default gesture, in fractions of the take, with a key either side so the
 * first and last frames are mid-move rather than at rest.
 */
const GESTURE: Key[] = [
    { t: -0.4, x: -1.5, y: 0.05 },
    { t: 0, x: -1.1, y: -0.1 },
    { t: 0.5, x: 1.3, y: 0.3 },
    { t: 1, x: -0.5, y: 0 },
    { t: 1.4, x: -1.4, y: -0.1 },
];

/** `x[:y]@seconds` entries; a bad or missing path is the default gesture. */
function parsePath(text: string | null, seconds: number): Key[] {
    const keys: Key[] = [];
    for (const entry of (text ?? '').split(',')) {
        const match = /^(-?[\d.]+)(?::(-?[\d.]+))?@(-?[\d.]+)$/.exec(entry.trim());
        if (!match) continue;
        const [x, y, t] = [Number(match[1]), Number(match[2] ?? 0), Number(match[3])];
        if ([x, y, t].every(Number.isFinite)) keys.push({ t, x, y });
    }
    keys.sort((a, b) => a.t - b.t);
    if (keys.length >= 2) return keys;
    return GESTURE.map((k) => ({ ...k, t: k.t * seconds }));
}

/**
 * The lean's target at `time`: the path through its keys (a Catmull-Rom spline, so
 * velocity is continuous and nothing stops or turns a corner), held flat beyond
 * the ends, and a faint breath on top so a straight run isn't dead straight.
 */
export function cameraPath({ path }: Recording): (time: number) => [number, number] {
    const keys = path;
    const spline = (time: number): [number, number] => {
        if (time <= keys[0].t) return [keys[0].x, keys[0].y];
        const last = keys[keys.length - 1];
        if (time >= last.t) return [last.x, last.y];
        let i = 0;
        while (keys[i + 1].t <= time) i++;
        const a = keys[i];
        const b = keys[i + 1];
        const before = keys[Math.max(0, i - 1)];
        const after = keys[Math.min(keys.length - 1, i + 2)];
        const span = b.t - a.t;
        const s = (time - a.t) / span;
        const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
        const h10 = s ** 3 - 2 * s ** 2 + s;
        const h01 = -2 * s ** 3 + 3 * s ** 2;
        const h11 = s ** 3 - s ** 2;
        // Tangents from the neighbours, in the segment's own time.
        const tangent = (p0: Key, p1: Key, axis: 'x' | 'y') => ((p1[axis] - p0[axis]) / (p1.t - p0.t)) * span;
        const axis = (k: 'x' | 'y') => h00 * a[k] + h10 * tangent(before, b, k) + h01 * b[k] + h11 * tangent(a, after, k);
        return [axis('x'), axis('y')];
    };
    return (time) => {
        const [x, y] = spline(time);
        const breath = (period: number, phase: number) => Math.sin((2 * Math.PI * time) / period + phase);
        return [x + 0.05 * breath(5.3, 0.4) + 0.03 * breath(2.9, 1.9), y + 0.04 * breath(6.1, 1.1) + 0.025 * breath(3.7, 0.3)];
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
