import { type Baked, type CaptureSplats, GRID } from '../../time/src/bake.ts';

const MAP = { cell: 0.1, ground: 0, proud: 0.35, above: [0.6, 1.2] };

const COVER = { from: 0.3, to: 0.7 };

const PUDDLES = { ground: 0, band: [0.15, 0.3], flat: [0.85, 0.97], green: [0.0, 0.05] };

export type Mesh = { positions: ArrayLike<number>; indices: ArrayLike<number> };

export type Reach = {
    rain: Float32Array<ArrayBuffer>;
    heights: Float32Array<ArrayBuffer>;
    size: [number, number];
    cell: number;
    origin: [number, number];
};

type HeightMap = Omit<Reach, 'rain'>;

export function reach(splats: CaptureSplats, baked: Baked, mesh: Mesh): Reach {
    const size: [number, number] = [
        Math.round((GRID.max[0] - GRID.min[0]) / MAP.cell),
        Math.round((GRID.max[2] - GRID.min[2]) / MAP.cell),
    ];
    const origin: [number, number] = [GRID.min[0], GRID.min[2]];
    const map: HeightMap = { heights: fromAbove(mesh, size, origin), size, cell: MAP.cell, origin };
    return { rain: perSplat(splats, baked, map), ...map };
}

function topAt(map: HeightMap, x: number, z: number): number {
    const ix = Math.floor((x - map.origin[0]) / map.cell);
    const iz = Math.floor((z - map.origin[1]) / map.cell);
    if (ix < 0 || iz < 0 || ix >= map.size[0] || iz >= map.size[1]) return MAP.ground;
    return map.heights[ix + map.size[0] * iz];
}

/* from above */

function fromAbove(mesh: Mesh, [nx, nz]: [number, number], [ox, oz]: [number, number]): Float32Array<ArrayBuffer> {
    const heights = new Float32Array(nx * nz).fill(-Infinity);
    const p = mesh.positions;
    const at = (k: number) => [(p[k * 3] - ox) / MAP.cell, p[k * 3 + 1], (p[k * 3 + 2] - oz) / MAP.cell];
    const keep = (x: number, y: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return;
        const i = ix + nx * iz;
        if (y > heights[i]) heights[i] = y;
    };

    for (let t = 0; t < mesh.indices.length; t += 3) {
        const [ax, ay, az] = at(mesh.indices[t]);
        const [bx, by, bz] = at(mesh.indices[t + 1]);
        const [cx, cy, cz] = at(mesh.indices[t + 2]);
        // Every corner counts, so a wall (edge-on from above) still marks its top.
        keep(ax, ay, az);
        keep(bx, by, bz);
        keep(cx, cy, cz);
        const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        if (Math.abs(area) < 1e-6) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
        const x1 = Math.min(nx - 1, Math.ceil(Math.max(ax, bx, cx)));
        const z0 = Math.max(0, Math.floor(Math.min(az, bz, cz)));
        const z1 = Math.min(nz - 1, Math.ceil(Math.max(az, bz, cz)));
        for (let z = z0; z <= z1; z++) {
            for (let x = x0; x <= x1; x++) {
                const px = x + 0.5;
                const pz = z + 0.5;
                const wa = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) / area;
                const wb = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) / area;
                const wc = 1 - wa - wb;
                if (wa < 0 || wb < 0 || wc < 0) continue;
                keep(px, wa * ay + wb * by + wc * cy, pz);
            }
        }
    }
    for (let i = 0; i < heights.length; i++) {
        const y = heights[i];
        heights[i] = y === -Infinity ? MAP.ground : y - MAP.proud * (1 - smoothstep(MAP.above[0], MAP.above[1], y));
    }
    return heights;
}

/* per splat */

function perSplat(splats: CaptureSplats, baked: Baked, map: HeightMap): Float32Array<ArrayBuffer> {
    const rain = new Float32Array(splats.count * 4);
    for (let i = 0; i < splats.count; i++) {
        // The capture's sky: nothing to wet.
        if (baked.light[i * 4 + 3] < 0) continue;
        const x = splats.centers[i * 3];
        const y = splats.centers[i * 3 + 1];
        const z = splats.centers[i * 3 + 2];
        const open = 1 - smoothstep(COVER.from, COVER.to, topAt(map, x, z) - y);

        const up = baked.light[i * 4 + 1];
        const r = splats.colours[i * 3];
        const g = splats.colours[i * 3 + 1];
        const b = splats.colours[i * 3 + 2];
        const green = g - Math.max(r, b);
        const puddle =
            open *
            smoothstep(PUDDLES.flat[0], PUDDLES.flat[1], up) *
            (1 - smoothstep(PUDDLES.green[0], PUDDLES.green[1], green)) *
            (1 - smoothstep(PUDDLES.band[0], PUDDLES.band[1], Math.abs(y - PUDDLES.ground)));

        rain[i * 4] = open;
        rain[i * 4 + 1] = puddle;
    }
    return rain;
}

function smoothstep(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
