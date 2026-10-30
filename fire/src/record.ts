import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

/* the take */

const SECONDS = 12;
const WARMUP = 5;
const STOKES = [4];
const SWAY = 1.5;
const LIFT = 0.22;

export type Recording = {
    fps: number;
    seconds: number;
    width: number;
    height: number;
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
