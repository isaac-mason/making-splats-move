// Bake the diorama's heightfield from the capture: for every cell of a grid over
// the diorama, the height of the top of what's solid there (roofs, awnings,
// ledges, street), which the snow lands on.
//
// Like lively-crossing's collider (generate-collision-mesh.ts), it reads the
// .spz itself and keeps only fairly opaque splats; but snow falls from above,
// so all it needs is the top surface, as a heightfield the GPU can sample, not a
// mesh. A cell's top is a high percentile of its splats' heights (a lone floater
// doesn't count), median-filtered, capped at the cut, and never below the base.
//
// Run after crop-city.mjs, from the cut capture.
//
// Usage: node scripts/bake-heights.mjs [in.spz] [out.bin]
// Writes `size` × `size` little-endian float32 heights, row by row (z), x within a row.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const INPUT = process.argv[2] ?? 'assets/diorama.spz';
const OUTPUT = process.argv[3] ?? 'assets/heights.bin';

/**
 * The cut and the grid, from diorama.json: cells across (so `size` × `cell`
 * metres square round the centre); how opaque (of 255) a splat must be to count
 * as solid; and which percentile of a cell's solid splats is its top.
 */
const DIORAMA = JSON.parse(readFileSync(new URL('../diorama.json', import.meta.url), 'utf8'));
const GRID = DIORAMA.heights;
const SOLID = GRID.solid;
const TOP = GRID.top;

const raw = gunzipSync(readFileSync(INPUT));
if (raw.readUInt32LE(0) !== 0x5053474e) throw new Error('not an SPZ');
const count = raw.readUInt32LE(8);
const frac = raw[13];
const alphaAt = 16 + count * 9;
const read = (i, k) => {
    const o = 16 + (i * 3 + k) * 3;
    let v = raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v / (1 << frac);
};

const { size, cell } = GRID;
const x0 = DIORAMA.centre[0] - (size * cell) / 2;
const z0 = DIORAMA.centre[1] - (size * cell) / 2;
const cells = Array.from({ length: size * size }, () => []);
for (let i = 0; i < count; i++) {
    if (raw[alphaAt + i] < SOLID) continue;
    const y = read(i, 1);
    if (y > DIORAMA.top || y < DIORAMA.base - 1) continue;
    const cx = Math.floor((read(i, 0) - x0) / cell);
    const cz = Math.floor((read(i, 2) - z0) / cell);
    if (cx < 0 || cz < 0 || cx >= size || cz >= size) continue;
    cells[cz * size + cx].push(y);
}

const top = new Float32Array(size * size);
for (let k = 0; k < top.length; k++) {
    const ys = cells[k].sort((a, b) => a - b);
    top[k] = ys.length >= 3 ? ys[Math.floor(TOP * (ys.length - 1))] : DIORAMA.base;
}

// A 3×3 median, so a single wild cell doesn't make a spike or a pit.
const heights = new Float32Array(size * size);
for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
        const around = [];
        for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++)
                around.push(top[Math.min(size - 1, Math.max(0, z + dz)) * size + Math.min(size - 1, Math.max(0, x + dx))]);
        around.sort((a, b) => a - b);
        heights[z * size + x] = Math.max(DIORAMA.base, Math.min(DIORAMA.top, around[4]));
    }
}

writeFileSync(OUTPUT, Buffer.from(heights.buffer));
const sorted = [...heights].sort((a, b) => a - b);
console.log(
    `${OUTPUT}: ${size}×${size} cells of ${cell} m, heights ${sorted[0].toFixed(2)} .. ${sorted.at(-1).toFixed(2)}, median ${sorted[sorted.length >> 1].toFixed(2)}`,
);
