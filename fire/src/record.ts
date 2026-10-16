/**
 * Perfect recordings: the frames rendered on a fixed clock and encoded in the page,
 * not a screen recording hoping to keep up. Each frame is exactly 1/fps on from the
 * last, at whatever size you ask for, so the file is constant-rate at any rate the
 * display can't do, and rendering slower than real time costs nothing.
 *
 * Encoding is WebCodecs (the hardware H.264 encoder, VP9 if it can't do the size and
 * rate) muxed to an MP4 in memory, then downloaded.
 *
 *   ?record=1              the take, as designed below
 *   &fps=60&width=3840&height=2160&mbps=150   the output format, when not 1080p120
 *
 * The take is designed here, not in the URL. The fire burns through a warmup
 * before the first frame, gets one stoke a third of the way in, and the camera
 * sways once across and back over the whole take, ending exactly as it began, so
 * the clip loops.
 */

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

/* the take */

/** Seconds of video. */
const SECONDS = 12;
/** Seconds simulated before the first frame, so the fire is already going. */
const WARMUP = 5;
/** Seconds into the take to stoke the fire. */
const STOKES = [4];
/** The sway's reach, where 1 is the lean at the window's edge. */
const SWAY = 1.5;
/** Its lift, the same scale: a touch of rise with the sway, not a circle. */
const LIFT = 0.22;

export type Recording = {
    fps: number;
    seconds: number;
    width: number;
    height: number;
    /** Video bitrate, megabits per second. */
    mbps: number;
    stokes: number[];
    warmup: number;
};

export function recordingFromUrl(): Recording | null {
    const params = new URLSearchParams(location.search);
    if (!params.has('record')) return null;
    const num = (name: string, fallback: number) => {
        const value = Number(params.get(name));
        return params.has(name) && Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
        fps: num('fps', 120),
        seconds: SECONDS,
        width: Math.round(num('width', 1920) / 2) * 2,
        height: Math.round(num('height', 1080) / 2) * 2,
        mbps: num('mbps', 60),
        stokes: STOKES,
        warmup: WARMUP,
    };
}

/**
 * Where the lean heads at `time`: one sine across the take, so it's at the same
 * place with the same velocity on the last frame as the first. The lift lags the
 * sway a little, a slanted, narrow loop rather than a circle. On top, a breath of
 * two slow sines that don't divide the take, so no run is dead straight.
 */
export function cameraPath({ seconds }: Recording): (time: number) => [number, number] {
    return (time) => {
        const phase = (2 * Math.PI * time) / seconds;
        const breath = (period: number, shift: number) => Math.sin((2 * Math.PI * time) / period + shift);
        return [
            SWAY * Math.sin(phase) + 0.05 * breath(5.3, 0.4) + 0.03 * breath(2.9, 1.9),
            LIFT * Math.sin(phase - 0.6) + 0.04 * breath(6.1, 1.1) + 0.025 * breath(3.7, 0.3),
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
