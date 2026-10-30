const PATH = { latitude: 40, declination: 12 };

const MOON = { colour: [0.28, 0.36, 0.56], tilt: 0.25 };

const SKYLIGHT = { tint: 0.5, glow: 0.6 };

type Key = {
    at: number;
    sun: number[];
    ambient: number[];
    zenith: number[];
    horizon: number[];
    exposure: number;
};

const KEYS: Key[] = [
    {
        at: -18,
        sun: [0, 0, 0],
        ambient: [0.03, 0.042, 0.085],
        zenith: [0.002, 0.004, 0.012],
        horizon: [0.008, 0.012, 0.028],
        exposure: 3.4,
    },
    {
        at: -9,
        sun: [0, 0, 0],
        ambient: [0.07, 0.095, 0.2],
        zenith: [0.012, 0.025, 0.08],
        horizon: [0.07, 0.07, 0.13],
        exposure: 2.4,
    },
    { at: -3, sun: [0, 0, 0], ambient: [0.2, 0.17, 0.27], zenith: [0.04, 0.07, 0.2], horizon: [0.5, 0.26, 0.2], exposure: 1.6 },
    {
        at: 1,
        sun: [1.3, 0.42, 0.14],
        ambient: [0.3, 0.25, 0.32],
        zenith: [0.07, 0.13, 0.33],
        horizon: [0.95, 0.46, 0.22],
        exposure: 1.25,
    },
    {
        at: 8,
        sun: [1.8, 0.98, 0.48],
        ambient: [0.38, 0.38, 0.48],
        zenith: [0.09, 0.19, 0.48],
        horizon: [0.8, 0.6, 0.45],
        exposure: 1.0,
    },
    {
        at: 25,
        sun: [1.85, 1.5, 1.08],
        ambient: [0.44, 0.5, 0.66],
        zenith: [0.09, 0.23, 0.6],
        horizon: [0.55, 0.64, 0.78],
        exposure: 0.86,
    },
    {
        at: 60,
        sun: [1.85, 1.72, 1.5],
        ambient: [0.46, 0.53, 0.7],
        zenith: [0.08, 0.22, 0.6],
        horizon: [0.5, 0.62, 0.8],
        exposure: 0.82,
    },
];

export type Daylight = {
    hour: number;
    elevation: number;
    sun: [number, number, number];
    moon: [number, number, number];
    light: [number, number, number];
    lightColour: [number, number, number];
    sunColour: [number, number, number];
    skyUp: [number, number, number];
    skySide: [number, number, number];
    glow: [number, number, number];
    toward: [number, number, number];
    zenith: [number, number, number];
    horizon: [number, number, number];
    exposure: number;
    night: number;
};

export function daylightAt(hour: number): Daylight {
    const sun = sunDirection(hour);
    const elevation = (Math.asin(sun[1]) * 180) / Math.PI;
    const key = blendKeys(elevation);

    // The moon rides opposite the sun, tipped south so it isn't overhead at midnight.
    const moon = normalize([-sun[0], Math.max(-sun[1], 0) * (1 - MOON.tilt), -sun[2] + MOON.tilt]);
    const night = smoothstep(-6, -14, elevation);
    const sunUp = smoothstep(-1.5, 1.5, elevation);
    const moonUp = night * smoothstep(0, 0.15, moon[1]);
    const mean = key.zenith.map((z, i) => (z + key.horizon[i]) / 2);
    const shift = (c: number[]) =>
        chroma(c).map((v, i) => {
            const relative = Math.min(Math.max(v / chroma(mean)[i], 0.4), 2.5);
            return key.ambient[i] * (1 + (relative - 1) * SKYLIGHT.tint);
        }) as [number, number, number];
    const glowing = SKYLIGHT.glow * luminance(key.ambient) * smoothstep(-8, -2, elevation) * smoothstep(30, 6, elevation);

    const bySun = elevation > -7.5;
    const light = bySun ? sun : moon;
    const strength = bySun ? sunUp : moonUp;
    const colour = bySun ? key.sun : MOON.colour;

    return {
        hour,
        elevation,
        sun,
        moon,
        // Never quite flat: a light along the ground would march forever.
        light: normalize([light[0], Math.max(light[1], 0.03), light[2]]),
        lightColour: colour.map((c) => c * strength) as [number, number, number],
        sunColour: key.sun.map((c) => c * sunUp) as [number, number, number],
        skyUp: shift(key.zenith),
        skySide: shift(key.horizon),
        glow: chroma(key.horizon).map((c) => c * glowing) as [number, number, number],
        toward: normalize([sun[0], 0, sun[2]]),
        zenith: key.zenith as [number, number, number],
        horizon: key.horizon as [number, number, number],
        exposure: key.exposure,
        night,
    };
}

export function sunDirection(hour: number): [number, number, number] {
    const h = ((hour - 12) / 12) * Math.PI;
    const lat = (PATH.latitude * Math.PI) / 180;
    const dec = (PATH.declination * Math.PI) / 180;
    const east = -Math.sin(h) * Math.cos(dec);
    const up = Math.cos(h) * Math.cos(dec) * Math.cos(lat) + Math.sin(dec) * Math.sin(lat);
    const south = Math.cos(h) * Math.cos(dec) * Math.sin(lat) - Math.sin(dec) * Math.cos(lat);
    return normalize([east, up, south]);
}

export function hoursPerSecond(elevation: number): number {
    return 0.07 + 0.38 * smoothstep(10, 28, Math.abs(elevation));
}

function blendKeys(elevation: number): Key {
    const e = Math.min(Math.max(elevation, KEYS[0].at), KEYS[KEYS.length - 1].at);
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].at < e) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = smoothstep(a.at, b.at, e);
    const mix = (x: number[], y: number[]) => x.map((v, k) => v + (y[k] - v) * t);
    return {
        at: e,
        sun: mix(a.sun, b.sun),
        ambient: mix(a.ambient, b.ambient),
        zenith: mix(a.zenith, b.zenith),
        horizon: mix(a.horizon, b.horizon),
        // Blended in stops, as an eye adapts.
        exposure: Math.exp(Math.log(a.exposure) + (Math.log(b.exposure) - Math.log(a.exposure)) * t),
    };
}

function luminance(c: number[]): number {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function chroma(c: number[]): number[] {
    const l = Math.max(luminance(c), 1e-6);
    return c.map((v) => v / l);
}

function normalize(v: number[]): [number, number, number] {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

function smoothstep(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
